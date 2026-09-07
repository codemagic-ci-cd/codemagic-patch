/**
 * The one TLS question the install wizard asks: when the distribution is
 * greeted with the *viewer* hostname, does it offer a certificate for that
 * name?
 *
 * This is the check `fetch` cannot make. A request to the distribution domain
 * sends the distribution domain as SNI, and CloudFront answers it with its
 * default `*.cloudfront.net` certificate whether or not the alternate domain
 * name is attached — so every fetch-based probe passes on a distribution that
 * would serve nothing after the cutover. Sending the viewer name as SNI asks
 * the question the cutover is about to ask for real, while the DNS record is
 * still safely pointing at the server.
 */

import { checkServerIdentity, connect, type PeerCertificate } from "node:tls";

export type TlsNameProbe =
  /** The certificate offered for `servername` covers it. */
  | { kind: "covers" }
  /** A handshake, but the certificate names something else. */
  | { kind: "wrong-name"; certificateFor: string }
  /**
   * The server refused the handshake for this SNI outright. What CloudFront
   * actually does for a name no distribution claims — observed live: alert 40
   * rather than a fallback to the default certificate — so it means the same
   * thing as `wrong-name` and must not be mistaken for the host being down.
   */
  | { kind: "refused" }
  | { kind: "unreachable"; reason: string };

export type ProbeTlsName = (input: {
  /** The host actually connected to — the distribution domain. */
  host: string;
  /** The name asked for in the handshake — the viewer hostname. */
  servername: string;
}) => Promise<TlsNameProbe>;

const HANDSHAKE_TIMEOUT_MILLISECONDS = 10_000;

export function createTlsNameProbe(): ProbeTlsName {
  return ({ host, servername }) =>
    new Promise((resolve) => {
      // The chain is not the question: both the default certificate and an
      // attached ACM one validate against the system store. Only the name on
      // the offered certificate separates a claimed viewer hostname from an
      // unclaimed one, so the identity check is run by hand below.
      const socket = connect({
        host,
        port: 443,
        rejectUnauthorized: false,
        servername,
      });

      let settled = false;
      const settle = (result: TlsNameProbe) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(HANDSHAKE_TIMEOUT_MILLISECONDS, () => {
        settle({ kind: "unreachable", reason: "the connection timed out" });
      });
      socket.on("error", (error) => {
        // A TLS-layer alert is the server answering "not for that name";
        // only network-layer failures mean it could not be reached at all.
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "";
        settle(
          code.startsWith("ERR_SSL_")
            ? { kind: "refused" }
            : { kind: "unreachable", reason: error.message },
        );
      });
      socket.on("secureConnect", () => {
        const certificate = socket.getPeerCertificate();
        const mismatch = checkServerIdentity(servername, certificate);
        settle(
          mismatch === undefined
            ? { kind: "covers" }
            : { certificateFor: describeCertificate(certificate), kind: "wrong-name" },
        );
      });
    });
}

/**
 * The names on a certificate, as a user would recognise them — the SANs when
 * present (`*.cloudfront.net` is what actually identifies the default
 * certificate), the subject CN otherwise.
 */
function describeCertificate(certificate: PeerCertificate): string {
  const altNames = (certificate.subjectaltname ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^DNS:/u, ""))
    .filter((name) => name.length > 0);
  if (altNames.length > 0) {
    return altNames.join(", ");
  }

  const commonName = certificate.subject?.CN;
  return typeof commonName === "string" && commonName.length > 0
    ? commonName
    : "an unnamed certificate";
}
