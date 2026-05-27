# Feedback Intake

This app sends authenticated user feedback directly to Linear.

## App Configuration

Set these environment variables in Vercel and locally:

```bash
LINEAR_API_KEY="lin_api_..."
LINEAR_TEAM_ID="..."
LINEAR_FEEDBACK_PROJECT_ID=""
LINEAR_FEEDBACK_LABELS="customer-feedback"
```

`LINEAR_API_KEY` and `LINEAR_TEAM_ID` are required.

The app creates labels on demand when the Linear API key has permission. If label creation is not allowed, feedback still creates an issue and Linear Triage Intelligence can suggest labels.

## Linear Setup

Use a dedicated Linear team for feedback intake if possible.

1. Enable Triage in Linear Team Settings > Triage.
2. Enable Triage Intelligence in Settings > AI.
3. In the team triage suggestion settings, auto-apply labels, project, and assignee suggestions where the recommendations are trusted.
4. Add triage responsibility for the person rotating on feedback.

Linear's docs describe Triage as the inbox for integration-created issues and Triage Intelligence as the agentic model layer that suggests labels, teams, projects, assignees, and duplicates for new triage issues.

## Recommended Flow

1. User submits feedback in the app.
2. App creates a Linear issue with app/user/workspace context, the current session ID when submitted from a session page, and first-pass labels.
3. Linear Triage Intelligence enriches the issue.
4. The feedback owner accepts, dedupes, scopes, or ships from Linear.

GitHub Issues can work as a downstream engineering tracker, but Linear should stay first in the path because its Triage, Customer Requests, and AI suggestions are purpose-built for fast intake.
