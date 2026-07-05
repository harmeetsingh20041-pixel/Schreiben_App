# Production Cleanup Plan

Phase 6D audits production-visible test data and fixes database lint before real onboarding. No cleanup deletion has been executed yet.

## Current Audit Summary

Supabase currently contains:

- 2 Auth users, both real reachable test accounts.
- 2 profiles, both real reachable test profiles whose display names still contain Phase 4 wording.
- 1 visible test workspace graph:
  - workspace: `eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f`
  - batch: `fc71cbd4-414d-4e9f-90f6-88d841b310bd`
  - workspace question: `6a83c716-fd5f-42e5-8599-5e60d10793dd`
  - approved join request: `9edeb9b4-b32f-49af-b7fa-094509a04a98`
  - batch assignment: `696a6aa6-21b2-43ef-956f-2d5306017ce8`
  - 13 submissions
  - 15 submission line rows
  - 1 submission grammar-topic row
  - 7 usage-event rows
- 47 active imported A2 global writing tasks.
- 0 student invitations.
- 0 fake/unreachable Auth users matching `example.org`, `example.com`, `authcheck`, or phase/test email patterns.

The real test account emails are intentionally not written into this committed document. Their profile IDs are:

- Teacher profile/Auth user: `0b23d636-6a04-46de-8f73-76d8f166c6f6`
- Student profile/Auth user: `a59e07f1-911f-4607-bc3d-7e18ebd22dda`

## Classification

### Safe To Delete After Approval

Delete the visible test workspace graph:

- `workspaces`: `eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f`
- `workspace_members`: `97641e53-d204-4119-bcc3-8bf6d52cbd78`, `2515fa54-0f75-4c7c-af80-a8ae0d652fe5`
- `batches`: `fc71cbd4-414d-4e9f-90f6-88d841b310bd`
- `batch_students`: `696a6aa6-21b2-43ef-956f-2d5306017ce8`
- `questions`: `6a83c716-fd5f-42e5-8599-5e60d10793dd`
- `batch_join_requests`: `9edeb9b4-b32f-49af-b7fa-094509a04a98`
- `submissions`:
  - `2f53bdcf-8d34-4f13-863d-0032aeafad8b`
  - `0e7c1bd0-f276-4af2-b477-62cfb282e7ed`
  - `7ad4b663-c022-4148-bef5-10835fb6ef08`
  - `4de29e77-7546-43f8-93f4-8a4c320e2c06`
  - `39bb6f43-6805-4b73-9807-3f7f3352b5fb`
  - `56fd10b8-e10d-4ca8-b6da-d34fa5f87357`
  - `9a9ce747-a156-478b-899b-cbe8dbca2580`
  - `9a8c62ab-19d7-4a4a-9621-6bde80348d6c`
  - `7da3d174-b5e8-4126-9c0c-32c2278a9b7b`
  - `2cbff682-60c9-44ec-9d79-fc8cf45e7e3b`
  - `a2f51963-a12d-45f3-9fd6-21871571c5c7`
  - `a8cf6319-f98e-4382-8fb8-2e8061ec82ed`
  - `9cf6a573-7f6a-44a8-894e-359094a89df5`
- `submission_lines`:
  - `1dab0104-8fc4-4a6a-af2b-437a64225fca`
  - `2a876767-3a37-4a5a-9696-419b51f2c1fb`
  - `8c9872d5-28da-4a91-bec9-48093c131f47`
  - `27923cae-4290-42aa-95ee-d2febf40db50`
  - `766acae3-671a-479b-8e8d-2e40c622f859`
  - `a8875d62-c6b7-4f7a-b99e-bae4341d024b`
  - `14839977-d81e-4d3c-94f6-1b71163ae01b`
  - `2aaf1572-2e0e-4aac-9db6-73b91f84122e`
  - `343091e4-d3b3-4b14-924f-22fc11d81082`
  - `7b49e27f-4b16-448b-b76d-6218b5d60f90`
  - `f0728c17-60d7-46dc-8291-3e5cbd7e5af0`
  - `23131b4f-a42e-4735-9787-cd03fef86a0b`
  - `1b5eb5fe-5bc5-4348-b922-c87d268b19ae`
  - `d8818e8e-5e34-41e9-9fc0-d5c04b4856ee`
  - `3987e455-4761-4598-a0b9-6dc33248f683`
- `submission_grammar_topics`: `da8d5ad1-76fc-4990-a1e7-ed84da36d607`
- `usage_events`:
  - `44b152ec-6cba-434f-bc27-44226b1ff018`
  - `04262080-3c75-456a-a287-1f6dadace825`
  - `04c8c62a-e142-4661-b897-a8ee4ea0b0e1`
  - `56e19f97-7e4c-40ef-8f6b-60789b74fcfa`
  - `b5390cbb-1938-42cf-abbf-1a0c4e110d32`
  - `2c7f04ff-c1ad-4322-b407-3f53a4ae4ecd`
  - `a5190cb9-1ab3-4f82-a068-ca6bf798d608`

### Keep But Rename

Keep the real reachable Auth users and profiles, but remove phase wording from display names and Auth user metadata:

- `0b23d636-6a04-46de-8f73-76d8f166c6f6` -> `Test Teacher`
- `a59e07f1-911f-4607-bc3d-7e18ebd22dda` -> `Test Student`

### Keep

Keep all 47 imported active A2 global writing tasks. They are production question-bank data, not throwaway test data.

### Unsure / User Decision

The recommendation is to delete the whole test workspace graph before production. If future manual testing is needed, create a fresh staging workspace or use a separate Supabase staging project so production data stays clean.

## Cascade Effects

Deleting workspace `eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f` cascades to:

- `workspace_members`
- `batches`
- `batch_students`
- `questions`
- `batch_join_requests`
- `student_invitations`
- `submissions`
- `usage_events`

Deleting the workspace submissions cascades to:

- `submission_lines`
- `submission_grammar_topics`
- `teacher_notes`

Deleting this workspace does not delete the two real Auth users or profiles.

## Proposed Cleanup SQL

Run only after explicit approval.

```sql
begin;

-- Keep real test accounts but remove production-visible phase wording.
update public.profiles
set
  full_name = case
    when id = '0b23d636-6a04-46de-8f73-76d8f166c6f6' then 'Test Teacher'
    when id = 'a59e07f1-911f-4607-bc3d-7e18ebd22dda' then 'Test Student'
    else full_name
  end,
  updated_at = now()
where id in (
  '0b23d636-6a04-46de-8f73-76d8f166c6f6',
  'a59e07f1-911f-4607-bc3d-7e18ebd22dda'
);

update auth.users
set raw_user_meta_data =
  coalesce(raw_user_meta_data, '{}'::jsonb)
  || case
    when id = '0b23d636-6a04-46de-8f73-76d8f166c6f6' then jsonb_build_object('full_name', 'Test Teacher')
    when id = 'a59e07f1-911f-4607-bc3d-7e18ebd22dda' then jsonb_build_object('full_name', 'Test Student')
    else '{}'::jsonb
  end,
  updated_at = now()
where id in (
  '0b23d636-6a04-46de-8f73-76d8f166c6f6',
  'a59e07f1-911f-4607-bc3d-7e18ebd22dda'
);

-- Delete the production-visible test workspace graph.
delete from public.workspaces
where id = 'eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f';

-- Verification: these should return zero after the delete.
select 'workspaces' as table_name, count(*) as remaining
from public.workspaces
where id = 'eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f'
union all
select 'batches', count(*)
from public.batches
where workspace_id = 'eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f'
union all
select 'questions', count(*)
from public.questions
where workspace_id = 'eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f'
union all
select 'submissions', count(*)
from public.submissions
where workspace_id = 'eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f'
union all
select 'workspace_members', count(*)
from public.workspace_members
where workspace_id = 'eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f'
union all
select 'usage_events', count(*)
from public.usage_events
where workspace_id = 'eb0d3dde-9806-4a3f-ac3a-9e34b3b2d95f';

-- Verification: these should remain.
select id, full_name, global_role
from public.profiles
where id in (
  '0b23d636-6a04-46de-8f73-76d8f166c6f6',
  'a59e07f1-911f-4607-bc3d-7e18ebd22dda'
)
order by full_name;

-- Change COMMIT to ROLLBACK for a dry run.
commit;
```

## Rollback Notes

- Before `commit`, use `rollback` to cancel.
- After `commit`, rollback requires restoring from a Supabase backup or recreating a fresh test workspace manually.
- The 47 global A2 tasks are not touched by the proposed cleanup.
- The scheduled feedback cron job is not touched by the proposed cleanup.

## Production Readiness Notes

- Clean test data before real student onboarding.
- Do not mix real production users/classes with development E2E data.
- Keep scheduled feedback cron active only when expected. Disable with:

```sql
select cron.unschedule('process-due-feedback-every-5-minutes');
```

- The default Supabase email sender should not be used at scale.
- Configure custom SMTP before production usage grows.
- A separate staging Supabase project is recommended for future E2E tests, scheduler tests, and DeepSeek prompt experiments.
- Do not create fake/unreachable Auth users; use real reachable test emails or a local Mailpit setup for local Supabase.
