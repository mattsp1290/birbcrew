-- Owner-bounded keyset scans for GET /v1/conversations. One index cannot serve both shapes:
-- (owner_id, member_id, conversation_id) is not in conversation order across an owner's members,
-- and (owner_id, conversation_id) would read all of the owner's rows to filter one member.
CREATE INDEX conversations_owner_listing ON birbcrew_ts.conversations (owner_id, conversation_id);
CREATE INDEX conversations_owner_member_listing ON birbcrew_ts.conversations (owner_id, member_id, conversation_id);
