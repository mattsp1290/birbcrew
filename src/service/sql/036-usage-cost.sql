-- Estimated cost in the usage ledger (docs/usage-metering.md). An estimate comes from the operator's
-- price table (usage-prices.ts), computed when the row is written and never recomputed, so a later
-- price never rewrites an earlier row.
--
-- Locks on existing tables, held until migrate() commits: ACCESS EXCLUSIVE on usage_ledger to add
-- two nullable columns without a default (no rewrite) and CHECKs NOT VALID (no row is scanned). As
-- in 025 to 032 it is taken with NOWAIT and retried, so the migration never waits in a lock queue.
-- Only short statements hold the ledger: an insert as a segment returns, or a read. After 60 s
-- without the lock it fails with 55P03 and applies nothing.
DO $$
DECLARE deadline timestamptz := clock_timestamp() + interval '60 seconds';
BEGIN
    LOOP
        BEGIN
            LOCK TABLE birbcrew_ts.usage_ledger IN ACCESS EXCLUSIVE MODE NOWAIT;
            RETURN;
        EXCEPTION WHEN lock_not_available THEN
            IF clock_timestamp() > deadline THEN RAISE; END IF;
        END;
        PERFORM pg_sleep(0.02 + random() * 0.08);
    END LOOP;
END $$;

ALTER TABLE birbcrew_ts.usage_ledger
    -- USD, exact: integer token counts times rates of at most six decimal places per million tokens.
    ADD COLUMN estimated_cost_usd numeric(22, 12),
    -- The rates the estimate used, USD per million tokens as decimal strings (usage-prices.ts Price).
    ADD COLUMN estimate_price jsonb,
    -- A provider-billed cost and an estimate never share a row, so the two totals never overlap.
    ADD CONSTRAINT usage_ledger_estimate_check CHECK (estimated_cost_usd IS NULL OR (estimated_cost_usd >= 0
        AND state = 'reported' AND model IS NOT NULL AND cost_usd IS NULL AND jsonb_typeof(estimate_price) = 'object')) NOT VALID,
    ADD CONSTRAINT usage_ledger_estimate_price_check CHECK ((estimated_cost_usd IS NULL) = (estimate_price IS NULL)) NOT VALID;
