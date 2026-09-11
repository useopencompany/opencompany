import * as z from "zod";
import type { CapabilityId } from "../actions/capabilities";
import {
  callGraph,
  createMicrosoftMcpService,
  graphId,
  graphIdSchema,
  graphPage,
  graphPageSchema,
  graphRecord,
  graphUrl,
  type MicrosoftMcpServiceInput,
  registerMicrosoftTool,
} from "./microsoft-mcp-server";

export const OUTLOOK_CALENDAR_TOOL_CAPABILITIES = {
  list_calendars: "query",
  list_events: "query",
  get_event: "query",
  check_availability: "query",
  get_schedule: "query",
  create_event: "write",
  update_event: "write",
  delete_event: "write",
  respond_to_invite: "write",
} as const satisfies Record<string, CapabilityId>;
const timestamp = z.iso.datetime({ offset: true });
const rangeSchema = { startTime: timestamp, endTime: timestamp };
const calendarSchema = { calendarId: graphIdSchema.optional() };
const attendee = z
  .object({
    email: z.email().max(320),
    name: z.string().max(200).optional(),
    type: z.enum(["required", "optional", "resource"]).optional(),
  })
  .strict();
const editableSchema = {
  subject: z.string().trim().min(1).max(500),
  body: z.string().max(30000).optional(),
  location: z.string().max(1000).optional(),
  attendees: z.array(attendee).max(50).optional(),
};
const EVENT_FIELDS =
  "id,subject,bodyPreview,start,end,isAllDay,isCancelled,showAs,type,seriesMasterId,organizer,attendees,location,webLink,responseStatus,isOrganizer";
const calendarPath = (calendarId?: string) =>
  calendarId ? `calendars/${graphId(calendarId)}` : "calendar";

export function createOutlookCalendarMcpService(input: MicrosoftMcpServiceInput) {
  return createMicrosoftMcpService({
    ...input,
    provider: "outlook-calendar",
    capabilities: OUTLOOK_CALENDAR_TOOL_CAPABILITIES,
    register(server, context) {
      const register = <S extends z.ZodRawShape>(
        name: keyof typeof OUTLOOK_CALENDAR_TOOL_CAPABILITIES,
        description: string,
        schema: S,
        execute: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
      ) =>
        registerMicrosoftTool(server, {
          name,
          description,
          schema,
          capability: OUTLOOK_CALENDAR_TOOL_CAPABILITIES[name],
          destructive: name === "delete_event",
          execute,
        });
      register(
        "list_calendars",
        "List the connected Microsoft account's calendars. Works with Microsoft 365 and personal Outlook accounts.",
        graphPageSchema,
        async (args) => {
          const page = await graphPage(
            context,
            graphUrl("calendars", {
              $top: String(args.pageSize ?? 25),
              $select: "id,name,color,isDefaultCalendar,canEdit,owner",
            }),
            args.pageToken,
          );
          return { calendars: page.items, nextPageToken: page.nextPageToken };
        },
      );
      register(
        "list_events",
        "List events and expanded recurring occurrences in a time range of at most 31 days. Use RFC 3339 timestamps with offsets. Defaults to the main calendar. Follow nextPageToken for complete results; event times are returned in UTC.",
        { ...calendarSchema, ...rangeSchema, ...graphPageSchema },
        async (args) => {
          validateRange(args);
          const page = await graphPage(
            context,
            graphUrl(`${calendarPath(args.calendarId)}/calendarView`, {
              startDateTime: args.startTime,
              endDateTime: args.endTime,
              $top: String(args.pageSize ?? 25),
              $select: EVENT_FIELDS,
              $orderby: "start/dateTime",
            }),
            args.pageToken,
          );
          return { events: page.items, timeZone: "UTC", nextPageToken: page.nextPageToken };
        },
      );
      register(
        "get_event",
        "Read one Outlook calendar event or occurrence, including its body. Event times are returned in UTC.",
        { eventId: graphIdSchema },
        async (args) => {
          const event = graphRecord(
            await callGraph(
              context,
              "GET",
              graphUrl(`events/${graphId(args.eventId)}`, { $select: `${EVENT_FIELDS},body` }),
            ),
          );
          if (event.body && typeof event.body === "object") {
            const body = graphRecord(event.body);
            if (typeof body.content === "string")
              return {
                ...event,
                body: { contentType: body.contentType, content: body.content.slice(0, 30000) },
                bodyTruncated: body.content.length > 30000,
              };
          }
          return event;
        },
      );
      register(
        "check_availability",
        "Read busy intervals from one of your calendars for up to 31 days. Works for personal Outlook and Microsoft 365 accounts. Expands recurring events and reads all pages; tentative, working-elsewhere, out-of-office, and unknown statuses count as busy. Results apply only to the selected calendar. Use get_schedule for Microsoft 365 colleagues or rooms.",
        { ...calendarSchema, ...rangeSchema },
        async (args) => {
          validateRange(args);
          const url = graphUrl(`${calendarPath(args.calendarId)}/calendarView`, {
            startDateTime: args.startTime,
            endDateTime: args.endTime,
            $top: "100",
            $select: "id,start,end,showAs,isCancelled",
            $orderby: "start/dateTime",
          });
          const busy: unknown[] = [];
          let token: string | undefined;
          for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
            const page = await graphPage(context, url, token);
            for (const event of page.items) {
              if (event.isCancelled === true || event.showAs === "free") continue;
              const start = graphRecord(event.start);
              const end = graphRecord(event.end);
              if (
                typeof start.dateTime !== "string" ||
                typeof end.dateTime !== "string" ||
                !Number.isFinite(Date.parse(`${start.dateTime}Z`)) ||
                !Number.isFinite(Date.parse(`${end.dateTime}Z`)) ||
                start.timeZone !== "UTC" ||
                end.timeZone !== "UTC"
              )
                throw new Error(
                  "Microsoft returned incomplete availability. Do not assume this time is free.",
                );
              busy.push({ start, end, status: event.showAs ?? "unknown" });
            }
            if (!page.nextPageToken)
              return {
                calendarId: args.calendarId ?? "default",
                startTime: args.startTime,
                endTime: args.endTime,
                timeZone: "UTC",
                busy,
                complete: true,
              };
            token = page.nextPageToken;
          }
          throw new Error(
            "This calendar has too many events to establish availability. Retry with a shorter time range; do not assume it is free.",
          );
        },
      );
      register(
        "get_schedule",
        "Get free/busy schedules for up to 20 Microsoft 365 users or rooms for up to 31 days. Microsoft does not support this endpoint for personal Outlook accounts; use check_availability for your own calendar. Per-schedule errors mean availability is unknown.",
        {
          ...rangeSchema,
          schedules: z.array(z.email().max(320)).min(1).max(20),
          intervalMinutes: z.number().int().min(5).max(1440).optional(),
        },
        async (args) => {
          validateRange(args);
          return callGraph(context, "POST", graphUrl("calendar/getSchedule"), {
            schedules: args.schedules,
            startTime: graphTime(args.startTime),
            endTime: graphTime(args.endTime),
            availabilityViewInterval: args.intervalMinutes ?? 30,
          });
        },
      );
      register(
        "create_event",
        "Create a new timed Outlook event. Start and end must include UTC offsets. Adding attendees sends meeting invitations. This does not create recurring or all-day events. Use update_event to reschedule an existing meeting.",
        { ...calendarSchema, ...rangeSchema, ...editableSchema },
        async (args) => {
          validateRange(args);
          return callGraph(context, "POST", graphUrl(`${calendarPath(args.calendarId)}/events`), {
            ...eventFields(args),
            start: graphTime(args.startTime),
            end: graphTime(args.endTime),
          });
        },
      );
      register(
        "update_event",
        "Update an existing Outlook event by its original id, preserving omitted fields. The attendees field replaces the full attendee list, so read the event first and preserve everyone the user wants to keep. Reschedule a timed event by providing both startTime and endTime with UTC offsets. Attendee changes can send updates. The body of an online meeting cannot be edited here because rewriting it would drop the join details. For recurring meetings use an occurrence id from list_events; changing an entire series or rescheduling all-day events is not supported.",
        {
          eventId: graphIdSchema,
          subject: editableSchema.subject.optional(),
          body: editableSchema.body,
          location: editableSchema.location,
          attendees: editableSchema.attendees,
          startTime: timestamp.optional(),
          endTime: timestamp.optional(),
        },
        async (args) => {
          const { eventId, startTime, endTime, ...fields } = args;
          if (!Object.values(fields).some((value) => value !== undefined) && !startTime && !endTime)
            throw new Error("Provide at least one field to update.");
          if (Boolean(startTime) !== Boolean(endTime))
            throw new Error("Provide both startTime and endTime to reschedule an event.");
          const url = graphUrl(`events/${graphId(eventId)}`, {
            $select: `${EVENT_FIELDS},isOnlineMeeting`,
          });
          const original = graphRecord(await callGraph(context, "GET", url));
          assertSingleEvent(original, eventId);
          // A PATCH replaces the whole body, and Microsoft stores Teams join
          // details inside it. Writing plain text over an online meeting's body
          // strips the join link, so v1 refuses that edit instead of silently
          // breaking the meeting. Every other field still updates normally.
          // https://learn.microsoft.com/en-us/graph/api/event-update#notes-for-updating-specific-properties
          if (fields.body !== undefined && original.isOnlineMeeting === true)
            throw new Error(
              "This is an online meeting, and replacing its body would remove the join details. Edit the body in Outlook, or update the subject, location, attendees, or times here.",
            );
          if (startTime && endTime) {
            if (original.isAllDay === true)
              throw new Error("Reschedule all-day events in Outlook.");
            validateRange({ startTime, endTime });
          }
          return callGraph(context, "PATCH", graphUrl(`events/${graphId(eventId)}`), {
            ...eventFields(fields),
            ...(startTime && endTime
              ? { start: graphTime(startTime), end: graphTime(endTime) }
              : {}),
          });
        },
      );
      register(
        "delete_event",
        "Delete one Outlook event or occurrence. If you are the organizer, Microsoft sends cancellations to attendees. Use a specific occurrence id from list_events for recurring meetings; deleting an entire series is not supported.",
        { eventId: graphIdSchema },
        async ({ eventId }) => {
          const url = graphUrl(`events/${graphId(eventId)}`);
          const event = graphRecord(await callGraph(context, "GET", url));
          assertSingleEvent(event, eventId);
          await callGraph(context, "DELETE", url);
          return { deleted: true, eventId };
        },
      );
      register(
        "respond_to_invite",
        "Accept, tentatively accept, or decline an Outlook meeting invitation. Sends a response by default. Read the event first and use a specific occurrence id for recurring meetings.",
        {
          eventId: graphIdSchema,
          response: z.enum(["accept", "tentativelyAccept", "decline"]),
          comment: z.string().max(2000).optional(),
          sendResponse: z.boolean().optional(),
        },
        async (args) => {
          const event = graphRecord(
            await callGraph(context, "GET", graphUrl(`events/${graphId(args.eventId)}`)),
          );
          assertSingleEvent(event, args.eventId);
          if (event.isOrganizer === true)
            throw new Error("You are the organizer of this event, not an invitee.");
          await callGraph(
            context,
            "POST",
            graphUrl(`events/${graphId(args.eventId)}/${args.response}`),
            { comment: args.comment ?? "", sendResponse: args.sendResponse ?? true },
          );
          return {
            eventId: args.eventId,
            response: args.response,
            responseSent: args.sendResponse ?? true,
          };
        },
      );
    },
  });
}
function validateRange(args: { startTime: string; endTime: string }) {
  const start = Date.parse(args.startTime),
    end = Date.parse(args.endTime);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 31 * 86400000
  )
    throw new Error("endTime must follow startTime by at most 31 days.");
}
function graphTime(value: string) {
  return { dateTime: new Date(value).toISOString().replace(/Z$/u, ""), timeZone: "UTC" };
}
function eventFields(args: {
  subject?: string | undefined;
  body?: string | undefined;
  location?: string | undefined;
  attendees?: z.infer<typeof attendee>[] | undefined;
}) {
  return {
    ...(args.subject !== undefined ? { subject: args.subject } : {}),
    ...(args.body !== undefined ? { body: { contentType: "Text", content: args.body } } : {}),
    ...(args.location !== undefined ? { location: { displayName: args.location } } : {}),
    ...(args.attendees !== undefined
      ? {
          attendees: args.attendees.map((item) => ({
            emailAddress: { address: item.email, ...(item.name ? { name: item.name } : {}) },
            type: item.type ?? "required",
          })),
        }
      : {}),
  };
}
function assertSingleEvent(event: Record<string, unknown>, eventId: string) {
  if (event.id !== eventId || event.isCancelled === true)
    throw new Error("The original event is unavailable or cancelled.");
  if (event.type === "seriesMaster")
    throw new Error(
      "Select a specific recurring occurrence from list_events. This operation cannot change the entire series.",
    );
}
