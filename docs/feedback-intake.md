# Feedback intake

The sidebar submits authenticated Bug, Feedback, or Idea reports to `POST /v1/feedback`. The product
API validates the report, derives the Actor and workspace from the session, rate-limits submissions,
and creates the Linear issue. The web app does not hold Linear credentials or dispatch issues
directly.

## API configuration

Configure these values in the API runtime (`prod` `/api`) and in local shared development values
when exercising feedback:

```bash
LINEAR_API_KEY="lin_api_..."
GOAT_FEEDBACK_LINEAR_TEAM_ID=""
GOAT_FEEDBACK_LINEAR_PROJECT_ID=""
GOAT_FEEDBACK_LINEAR_LABELS=""
```

`LINEAR_API_KEY` and `GOAT_FEEDBACK_LINEAR_TEAM_ID` are required for delivery. The project and
additional labels are optional. The service always applies the report-kind label and attempts to
create missing labels; insufficient label permissions do not block issue creation. Missing required
configuration fails only the feedback request, not the rest of the product.

The API includes bounded internal user, workspace, and Conversation context. It never accepts
client-supplied identity as authority.

## Linear setup

Use a dedicated Linear team when practical, enable Triage for that team, and assign a clear owner
for accepting, deduplicating, and routing feedback. Keep GitHub Issues downstream if engineering
work needs them; the product delivery path remains Linear.

## Verification

Submit one report of each kind from the sidebar. Confirm the API returns success, one issue is
created in the configured team with the expected labels and bounded context, and the browser never
receives a Linear credential. Also verify the user sees a clear error when API delivery is not
configured or Linear rejects the request.
