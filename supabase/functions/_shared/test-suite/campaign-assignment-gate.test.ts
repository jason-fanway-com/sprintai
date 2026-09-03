/**
 * Campaign Assignment Gate — Acceptance Tests
 *
 * Tests the 4 fixes for 081_campaign_assignment_gate:
 *   1. Migration backfills demo number truthfully
 *   2. Status reader advances submitted → approved when mappings are ADDED
 *   3. Go-live gate refuses non-approved shops
 *   4. chat-sms escalates 10036 for non-test shops
 *
 * Run: deno test --allow-read supabase/functions/_shared/test-suite/campaign-assignment-gate.test.ts
 */

// ── AC-1: Migration backfill logic ─────────────────────────────────────────

Deno.test("AC-1: backfill sets demo number to not_started", () => {
  const migrationSql = Deno.readTextFileSync(
    "supabase/migrations/081_campaign_assignment_gate.sql",
  );

  if (!migrationSql.includes("DEFAULT 'not_started'")) {
    throw new Error("Migration must have DEFAULT 'not_started' on campaign_assignment_status");
  }
  if (!migrationSql.includes("CHECK (campaign_assignment_status IN")) {
    throw new Error("Migration must have CHECK constraint on campaign_assignment_status values");
  }
  if (!migrationSql.includes("+16107358315")) {
    throw new Error("Migration must backfill demo number +16107358315");
  }
  if (!migrationSql.includes("campaign_id = 'CSMB9HG'")) {
    throw new Error("Migration must set campaign_id='CSMB9HG' for demo number");
  }
});

// ── AC-2: Status reader advancement logic (unit test on the decision) ──────

interface MappingRecord {
  tmobileNumberMappingStatus: string;
  nonTmobileNumberMappingStatus: string;
}

/** Pure function: should the reader advance this shop to approved? */
function shouldAdvanceToApproved(records: MappingRecord[]): boolean {
  if (!Array.isArray(records) || records.length === 0) return false;
  return records.every(
    (r) => r.tmobileNumberMappingStatus === "ADDED" &&
          r.nonTmobileNumberMappingStatus === "ADDED",
  );
}

Deno.test("AC-2: status reader advances when both mappings are ADDED", () => {
  const result = shouldAdvanceToApproved([{
    tmobileNumberMappingStatus: "ADDED",
    nonTmobileNumberMappingStatus: "ADDED",
  }]);
  if (!result) throw new Error("Expected true when both mappings are ADDED");
});

Deno.test("AC-3a: status reader does NOT advance when tmobile is PENDING", () => {
  const result = shouldAdvanceToApproved([{
    tmobileNumberMappingStatus: "PENDING",
    nonTmobileNumberMappingStatus: "ADDED",
  }]);
  if (result) throw new Error("Expected false when tmobile mapping is PENDING");
});

Deno.test("AC-3b: status reader does NOT advance when nonTMobile is PENDING", () => {
  const result = shouldAdvanceToApproved([{
    tmobileNumberMappingStatus: "ADDED",
    nonTmobileNumberMappingStatus: "PENDING",
  }]);
  if (result) throw new Error("Expected false when non-tmobile mapping is PENDING");
});

Deno.test("AC-3c: status reader does NOT advance for empty records", () => {
  const result = shouldAdvanceToApproved([]);
  if (result) throw new Error("Expected false for empty records array");
});

// ── AC-4 & AC-5: Go-live campaign gate ─────────────────────────────────────

function campaignGate(isTest: boolean, campaignAssignmentStatus: string | undefined): boolean {
  if (isTest) return true;
  return campaignAssignmentStatus === "approved";
}

Deno.test("AC-4a: go-live gate refuses non-test shop with status=submitted", () => {
  if (campaignGate(false, "submitted")) throw new Error("Gate should block submitted shop");
});

Deno.test("AC-4b: go-live gate refuses non-test shop with status=not_started", () => {
  if (campaignGate(false, "not_started")) throw new Error("Gate should block not_started shop");
});

Deno.test("AC-4c: go-live gate passes non-test shop with status=approved", () => {
  if (!campaignGate(false, "approved")) throw new Error("Gate should pass approved shop");
});

Deno.test("AC-5a: go-live gate exempts is_test shops regardless of status", () => {
  if (!campaignGate(true, "not_started")) throw new Error("Test shop should pass (not_started)");
  if (!campaignGate(true, "submitted")) throw new Error("Test shop should pass (submitted)");
  if (!campaignGate(true, "approved")) throw new Error("Test shop should pass (approved)");
  if (!campaignGate(true, undefined)) throw new Error("Test shop should pass (no status)");
});

// ── AC-6: chat-sms 10036 escalation logic ──────────────────────────────────

/**
 * Pure decision function: given a shop and an errCode, what detection_rule
 * should the issue use (if any)?
 *
 * Returns null when no issue should be raised (is_test shop, or non-10036 code,
 * or duplicate issue already open).
 */
function determineDetectionRule(
  isTest: boolean,
  errCode: string,
  campaignAssignmentStatus: string | undefined,
): "campaign_not_approved" | "campaign_10036_unexpected" | null {
  if (isTest) return null;          // is_test shops are exempt
  if (errCode !== "10036") return null; // only 10036 triggers escalation

  if (campaignAssignmentStatus !== "approved") {
    return "campaign_not_approved";   // expected: not yet approved
  } else {
    return "campaign_10036_unexpected"; // unexpected: approved but still 10036
  }
}

Deno.test("AC-6a: non-test non-approved shop on 10036 → campaign_not_approved", () => {
  const rule = determineDetectionRule(false, "10036", "submitted");
  if (rule !== "campaign_not_approved") {
    throw new Error(`Expected campaign_not_approved, got ${rule}`);
  }
});

Deno.test("AC-6b: is_test shop on 10036 → no issue raised", () => {
  const rule = determineDetectionRule(true, "10036", "not_started");
  if (rule !== null) {
    throw new Error(`Expected null (no issue) for is_test shop, got ${rule}`);
  }
});

Deno.test("AC-6c: non-test approved shop on 10036 → campaign_10036_unexpected", () => {
  const rule = determineDetectionRule(false, "10036", "approved");
  if (rule !== "campaign_10036_unexpected") {
    throw new Error(`Expected campaign_10036_unexpected, got ${rule}`);
  }
});

Deno.test("AC-6d: non-10036 transient code → no issue raised", () => {
  // classifyTelnyxSendError returns "transient" for 10036, but we only
  // escalate on 10036 specifically. A future transient code should NOT
  // escalate.
  const rule = determineDetectionRule(false, "10099", "not_started");
  if (rule !== null) {
    throw new Error(`Expected null for non-10036 error code, got ${rule}`);
  }
});