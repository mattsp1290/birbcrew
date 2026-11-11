ALTER TABLE birbcrew_ts.request_admissions DROP CONSTRAINT request_admissions_reason_check;
ALTER TABLE birbcrew_ts.request_admissions ADD CONSTRAINT request_admissions_reason_check
  CHECK (reason IN ('predecessor_failed','predecessor_cancelled','admission_unconfirmed'));
