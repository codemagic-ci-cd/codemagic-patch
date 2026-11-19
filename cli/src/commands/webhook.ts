import type {
  WebhookCreateCommand,
  WebhookDeliveriesCommand,
  WebhookDeliveryCommand,
  WebhookListCommand,
  WebhookRedeliverCommand,
  WebhookRemoveCommand,
  WebhookRotateSecretCommand,
  WebhookShowCommand,
  WebhookTestCommand,
  WebhookUpdateCommand,
} from "../commandTypes";
import {
  authenticatedRequest,
  type AuthenticatedRequestInit,
} from "../authenticatedRequest";
import { isRecord } from "../output";
import { assertMutationConfirmable, enforceMutationSafety } from "./mutationSafety";
import { resolveTeamId } from "./resolveNames";
import { buildApiUrl, buildApiUrlWithQuery, type CommandDeps } from "./shared";

type WebhookRef = { serverUrl: string; token?: string; webhookId: string };

const JSON_HEADERS = { "content-type": "application/json" };

function webhookPath(webhookId: string, suffix = ""): string {
  return `/v1/webhooks/${encodeURIComponent(webhookId)}${suffix}`;
}

function request(
  deps: CommandDeps,
  command: { serverUrl: string; token?: string },
  url: string,
  init: AuthenticatedRequestInit,
): Promise<unknown> {
  return authenticatedRequest(deps, {
    init,
    serverUrl: command.serverUrl,
    token: command.token,
    url,
  });
}

function readWebhook(deps: CommandDeps, command: WebhookRef): Promise<unknown> {
  return request(deps, command, buildApiUrl(command.serverUrl, webhookPath(command.webhookId)), {
    method: "GET",
  });
}

export async function executeWebhookList(
  command: WebhookListCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId = await resolveTeamId(command.team, command.serverUrl, command.token, deps);

  return request(
    deps,
    command,
    buildApiUrl(command.serverUrl, `/v1/teams/${encodeURIComponent(teamId)}/webhooks`),
    { method: "GET" },
  );
}

export function executeWebhookShow(
  command: WebhookShowCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return readWebhook(deps, command);
}

export async function executeWebhookCreate(
  command: WebhookCreateCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const teamId = await resolveTeamId(command.team, command.serverUrl, command.token, deps);

  return request(
    deps,
    command,
    buildApiUrl(command.serverUrl, `/v1/teams/${encodeURIComponent(teamId)}/webhooks`),
    {
      body: JSON.stringify({
        ...(command.description !== undefined ? { description: command.description } : {}),
        event_types: command.events,
        url: command.url,
      }),
      headers: JSON_HEADERS,
      method: "POST",
    },
  );
}

export function executeWebhookUpdate(
  command: WebhookUpdateCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return request(deps, command, buildApiUrl(command.serverUrl, webhookPath(command.webhookId)), {
    body: JSON.stringify({
      ...(command.description !== undefined ? { description: command.description } : {}),
      ...(command.events !== undefined ? { event_types: command.events } : {}),
      ...(command.status !== undefined ? { status: command.status } : {}),
      ...(command.url !== undefined ? { url: command.url } : {}),
    }),
    headers: JSON_HEADERS,
    method: "PATCH",
  });
}

export async function executeWebhookRemove(
  command: WebhookRemoveCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const safety = {
    commandName: "webhook remove",
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  };
  // The note names the URL the read finds; refuse first a run that could not
  // answer the confirm.
  assertMutationConfirmable(deps, safety);

  const url = readWebhookUrl(await readWebhook(deps, command));
  await enforceMutationSafety(deps, {
    ...safety,
    fields: [
      ["serverUrl", command.serverUrl],
      ["webhookId", command.webhookId],
      ["url", url],
      ["effect", "events stop going to this URL; its delivery history is deleted"],
    ],
  });

  await request(deps, command, buildApiUrl(command.serverUrl, webhookPath(command.webhookId)), {
    method: "DELETE",
  });

  return { deleted: true, id: command.webhookId, resource: "webhook" };
}

export async function executeWebhookRotateSecret(
  command: WebhookRotateSecretCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const safety = {
    commandName: "webhook rotate-secret",
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  };
  assertMutationConfirmable(deps, safety);

  const url = readWebhookUrl(await readWebhook(deps, command));
  await enforceMutationSafety(deps, {
    ...safety,
    fields: [
      ["serverUrl", command.serverUrl],
      ["webhookId", command.webhookId],
      ["url", url],
      ["effect", "the current secret stops verifying at once, retries included"],
    ],
  });

  return request(
    deps,
    command,
    buildApiUrl(command.serverUrl, webhookPath(command.webhookId, "/rotate-secret")),
    { method: "POST" },
  );
}

export function executeWebhookTest(
  command: WebhookTestCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return request(
    deps,
    command,
    buildApiUrl(command.serverUrl, webhookPath(command.webhookId, "/test")),
    { method: "POST" },
  );
}

export function executeWebhookDeliveries(
  command: WebhookDeliveriesCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return request(
    deps,
    command,
    buildApiUrlWithQuery(command.serverUrl, webhookPath(command.webhookId, "/deliveries"), {
      limit: command.limit,
      offset: command.offset,
      status: command.status,
    }),
    { method: "GET" },
  );
}

function deliveryPath(command: { deliveryId: string; webhookId: string }, suffix = ""): string {
  return webhookPath(
    command.webhookId,
    `/deliveries/${encodeURIComponent(command.deliveryId)}${suffix}`,
  );
}

export function executeWebhookDelivery(
  command: WebhookDeliveryCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return request(deps, command, buildApiUrl(command.serverUrl, deliveryPath(command)), {
    method: "GET",
  });
}

export function executeWebhookRedeliver(
  command: WebhookRedeliverCommand,
  deps: CommandDeps,
): Promise<unknown> {
  return request(
    deps,
    command,
    buildApiUrl(command.serverUrl, deliveryPath(command, "/redeliver")),
    { method: "POST" },
  );
}

function readWebhookUrl(response: unknown): string | undefined {
  const webhook = isRecord(response) && isRecord(response.webhook) ? response.webhook : undefined;

  return typeof webhook?.url === "string" ? webhook.url : undefined;
}
