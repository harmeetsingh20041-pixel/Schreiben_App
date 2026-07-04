# Supabase Email-Safe Testing Policy

This policy applies to all remote Supabase Auth and invitation testing for the Schreiben App project.

## Rules

- Use only real reachable email addresses or owned Gmail aliases for Supabase Auth testing.
- Prefer Gmail aliases such as `your-address+schreiben-teacher-test@gmail.com` and `your-address+schreiben-student-test@gmail.com` when repeatable test accounts are needed.
- Never create Supabase Auth users with fake, reserved, or unreachable addresses such as `example.com`, `example.org`, `.test`, or random Gmail addresses that nobody owns.
- Do not resend confirmation emails to fake or unreachable users.
- Do not create new remote Auth users just to bypass a blocked test flow.
- Use Mailpit only with local Supabase testing through `supabase start`, where outbound emails are captured locally instead of sent publicly.
- Configure custom SMTP before production-scale signup, invitation, or classroom onboarding tests.
- Redact test emails and passwords in reports, screenshots, logs, and commits unless the user explicitly asks otherwise.
- Never commit passwords, Supabase keys, `.env.local`, database passwords, or service-role credentials.

## Remote Testing Workflow

1. Ask the user for one reachable teacher test email, one reachable student test email, and a temporary password.
2. Use only those two accounts for the final end-to-end Auth test.
3. If confirmation is required, wait for the user to confirm the email manually before retrying login.
4. Do not resend confirmations unless the address is known reachable and the user approves.
5. Audit test data before cleanup and delete remote test data only after explicit user approval.

## Local Testing Workflow

Local Auth email testing should use the local Supabase stack and Mailpit:

```sh
supabase start
```

Open the local Mailpit URL printed by Supabase CLI and inspect confirmation emails there. Mailpit is for local testing only; it does not make fake remote email addresses safe to use in the linked hosted project.

## Production Preparation

Before inviting real cohorts or running larger signup tests:

- Configure a custom SMTP provider in Supabase Auth.
- Verify sender domain authentication with the provider.
- Keep confirmation, rate-limit, and bounce monitoring enabled.
- Test with a small set of reachable internal addresses first.
