-- The Phase 6A compatibility migration briefly added this index, but the
-- schema already has submission_lines_submission_line_idx on the same columns.
drop index if exists public.submission_lines_submission_line_number_idx;
