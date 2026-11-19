// Create and edit share one form: where events go, which events, and a note.
// The URL is checked here only for shape; whether http or a private address
// is allowed depends on the server's configuration, so the server's own field
// error is shown under the field when it refuses one.

import { useState } from "react";
import type { FormEvent } from "react";

import { HttpProblemError } from "../../api/problem";
import { Modal } from "../../components/overlay/Modal";
import { buttonVariants } from "../../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../../components/ui/callout";
import {
  FIELD,
  FIELD_ERR,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
} from "../../components/ui/form";
import {
  checkWebhookUrl,
  describeWebhookEventType,
  webhookEventOptions,
  type Webhook,
} from "../../model/webhook";
import { problemMessage } from "./shared";

export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 200;

export interface WebhookFormValues {
  description: string | null;
  /** Empty means every event type. */
  eventTypes: string[];
  url: string;
}

interface WebhookFormModalProps {
  /** The request error of the last submit, if any. */
  error: unknown;
  /** Present when editing; absent when creating. */
  initial?: Webhook;
  onClose: () => void;
  onSubmit: (values: WebhookFormValues) => void;
  pending: boolean;
}

const URL_PROBLEM_COPY = {
  empty: "Enter the URL that should receive events.",
  not_a_url: "Enter a full URL, for example https://example.com/hooks/patch.",
  unsupported_scheme: "The URL must start with https://.",
} as const;

export function WebhookFormModal({
  error,
  initial,
  onClose,
  onSubmit,
  pending,
}: WebhookFormModalProps) {
  const editing = initial !== undefined;
  const [url, setUrl] = useState(initial?.url ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [allEvents, setAllEvents] = useState((initial?.eventTypes.length ?? 0) === 0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    new Set(initial?.eventTypes ?? []),
  );
  const eventOptions = webhookEventOptions(initial?.eventTypes ?? []);
  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const [eventsProblem, setEventsProblem] = useState<string | null>(null);

  const requestClose = () => {
    if (!pending) {
      onClose();
    }
  };

  const toggleEvent = (type: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }

    const problem = checkWebhookUrl(url);
    const noEventPicked = !allEvents && selected.size === 0;
    setUrlProblem(problem === null ? null : URL_PROBLEM_COPY[problem]);
    setEventsProblem(
      noEventPicked ? "Pick at least one event, or choose all events." : null,
    );
    if (problem !== null || noEventPicked) {
      return;
    }

    const note = description.trim();
    onSubmit({
      description: note.length === 0 ? null : note,
      // Keep the listed order whatever order the boxes were ticked in.
      eventTypes: allEvents ? [] : eventOptions.filter((type) => selected.has(type)),
      url: url.trim(),
    });
  };

  const serverUrlProblem = fieldErrorFor(error, "url");
  const shownUrlProblem = urlProblem ?? serverUrlProblem;
  const formId = editing ? "edit-webhook-form" : "create-webhook-form";

  return (
    <Modal
      open
      onClose={requestClose}
      title={editing ? "Edit webhook" : "Add webhook"}
      description={
        editing ? "Changes apply to events recorded from now on." : undefined
      }
      footer={
        <>
          <button
            type="button"
            className={buttonVariants({ intent: "subtle" })}
            onClick={requestClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonVariants({ intent: "primary" })}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? <span className="spinner sm" aria-hidden="true" /> : null}
            {editing ? "Save changes" : "Add webhook"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} noValidate>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>URL</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/hooks/patch"
            autoComplete="off"
            aria-invalid={shownUrlProblem !== null || undefined}
          />
          {shownUrlProblem !== null ? (
            <span className={FIELD_ERR} role="alert">
              {shownUrlProblem}
            </span>
          ) : (
            <span className={FIELD_HINT}>
              An https address this server can reach. Each request to it is signed.
            </span>
          )}
        </label>

        <label className={FIELD}>
          <span className={FIELD_LABEL}>Description (optional)</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={description}
            maxLength={WEBHOOK_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="e.g. Release channel bot"
            autoComplete="off"
          />
        </label>

        <fieldset className={FIELD}>
          <legend className={FIELD_LABEL}>Events</legend>
          <label className="mb-2 flex items-center gap-2.5 text-[14px]">
            <input
              type="radio"
              name="webhook-events"
              checked={allEvents}
              onChange={() => setAllEvents(true)}
            />
            All events, including ones added later
          </label>
          <label className="mb-2 flex items-center gap-2.5 text-[14px]">
            <input
              type="radio"
              name="webhook-events"
              checked={!allEvents}
              onChange={() => setAllEvents(false)}
            />
            Only the events I pick
          </label>
          {!allEvents ? (
            <div className="ml-[26px] mt-1 grid gap-2">
              {eventOptions.map((type) => (
                <label key={type} className="flex items-start gap-2.5 text-[14px]">
                  <input
                    type="checkbox"
                    className="mt-[3px]"
                    checked={selected.has(type)}
                    onChange={() => toggleEvent(type)}
                  />
                  <span>
                    <span className="font-mono text-[13px] font-semibold">{type}</span>
                    <span className="block text-[13px] text-fg-3">
                      {describeWebhookEventType(type)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {eventsProblem !== null ? (
            <span className={FIELD_ERR} role="alert">
              {eventsProblem}
            </span>
          ) : null}
        </fieldset>

        {error !== null && error !== undefined && serverUrlProblem === null ? (
          <div className={`${CALLOUT} ${CALLOUT_TONE.danger}`} role="alert">
            <div>{problemMessage(error)}</div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/** The server's message for one field of a validation problem, if it sent one. */
function fieldErrorFor(error: unknown, field: string): string | null {
  if (!(error instanceof HttpProblemError)) {
    return null;
  }
  const match = error.errors?.find((entry) => entry.field === field);
  return match?.message ?? null;
}
