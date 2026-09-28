import type { RawRegion } from "@kavach/core/policy";
import type { Box } from "@kavach/core/schema";
import type { GroundTruthItem } from "./scoring.js";

/**
 * RedactBench-Web v0: structured captures. Each capture is a page as the
 * content script perceives it (regions with raw values) plus human ground
 * truth: what must be redacted, what must NOT be (the negatives that make
 * precision measurable), and the severity that feeds the leak rate.
 *
 * All personal data is synthetic. Aadhaar values use the UIDAI published
 * test range; names and contacts are invented.
 *
 * v0 is structure-level. When pixel captures land, the same ground truth
 * schema gains image files and pixel-space boxes.
 */

export interface Capture {
  id: string;
  slice: string;
  description: string;
  regions: RawRegion[];
  groundTruth: GroundTruthItem[];
}

type R = Partial<RawRegion> & Pick<RawRegion, "id" | "role" | "box">;

function region(r: R): RawRegion {
  return {
    label: null,
    source: "dom",
    confidence: 0.97,
    evidence: ["structural:role"],
    explained: true,
    ...r,
  };
}

const input = (id: string, label: string, box: Box, value: string, extra: Partial<RawRegion> = {}): RawRegion =>
  region({
    id,
    role: "textbox",
    label,
    box,
    state: { filled: value.length > 0, required: true },
    rawValue: value,
    ...extra,
  });

const text = (id: string, content: string, box: Box): RawRegion =>
  region({ id, role: "text", box, rawText: content });

const gt = (
  cls: string,
  box: Box,
  severity: GroundTruthItem["severity"],
  mustRedact = true,
  note?: string,
): GroundTruthItem => {
  const item: GroundTruthItem = { cls, box, mustRedact, severity: severity ?? "medium" };
  if (note) item.note = note;
  return item;
};

export const CORPUS: Capture[] = [
  {
    id: "gov_form_1",
    slice: "government",
    description: "Application form: filled Aadhaar and PAN, applicant photo, submit",
    regions: [
      input("e1", "Aadhaar Number", [40, 100, 280, 36], "9999 4105 7058"),
      input("e2", "PAN", [40, 160, 280, 36], "ABCPE1234F"),
      input("e3", "PIN Code", [40, 220, 140, 36], ""),
      region({
        id: "e4", role: "image", label: "Applicant photo", box: [400, 100, 96, 120],
        source: "vision", confidence: 0.93, evidence: ["visual:face-detector"],
        visualClass: "FACE",
      }),
      region({
        id: "e5", role: "button", label: "Submit Application", box: [40, 300, 180, 40],
        state: { disabled: false }, risk: "state_changing",
      }),
    ],
    groundTruth: [
      gt("AADHAAR", [40, 100, 280, 36], "invariant"),
      gt("PAN", [40, 160, 280, 36], "invariant"),
      gt("FACE", [400, 100, 96, 120], "invariant"),
    ],
  },
  {
    id: "gov_notice_2",
    slice: "government",
    description: "Notice page: Aadhaar in running text, address in text (Tier 0 gap)",
    regions: [
      text("e1", "Notice for holder of Aadhaar 999941057058 regarding verification.", [40, 100, 600, 22]),
      text("e2", "Registered address: 14 Nehru Marg, Gandhinagar", [40, 140, 600, 22]),
      text("e3", "Notice number 784512369014 issued under section 12.", [40, 180, 600, 22]),
    ],
    groundTruth: [
      gt("AADHAAR", [40, 100, 600, 22], "invariant"),
      gt("ADDRESS", [40, 140, 600, 22], "high", true, "free-text address: needs the NER tier"),
      gt("AADHAAR", [40, 180, 600, 22], "invariant", false, "12 digits, fails Verhoeff: a notice number"),
    ],
  },
  {
    id: "banking_dashboard_1",
    slice: "banking",
    description: "Account overview: balance, account number, IFSC, helpline negative",
    regions: [
      text("e1", "Savings A/C 123456789012", [40, 100, 300, 22]),
      text("e2", "Balance: ₹48,230.11", [40, 140, 300, 22]),
      text("e3", "Branch IFSC SBIN0005943", [40, 180, 300, 22]),
      text("e4", "Customer care 1800-000-000 toll free", [40, 220, 300, 22]),
      text("e5", "Transaction ref 784512369014 processed", [40, 260, 340, 22]),
    ],
    groundTruth: [
      gt("BANK_ACCOUNT", [40, 100, 300, 22], "high"),
      gt("AMOUNT", [40, 140, 300, 22], "high"),
      gt("IFSC", [40, 180, 300, 22], "high"),
      gt("PHONE_IN", [40, 220, 300, 22], "high", false, "toll free helpline, public"),
      gt("AADHAAR", [40, 260, 340, 22], "invariant", false, "transaction ref"),
    ],
  },
  {
    id: "banking_transfer_2",
    slice: "banking",
    description: "Transfer form: beneficiary VPA, card via autocomplete, mobile",
    regions: [
      input("e1", "Beneficiary UPI ID", [40, 100, 300, 36], "ramesh.kumar@okicici"),
      input("e2", "Card Number", [40, 160, 300, 36], "4111 1111 1111 1111", {
        structuralClass: "CARD_NUMBER",
      }),
      input("e3", "Registered Mobile", [40, 220, 300, 36], "+91 98765 43210", {
        structuralClass: "PHONE_IN",
      }),
    ],
    groundTruth: [
      gt("UPI_VPA", [40, 100, 300, 36], "high"),
      gt("CARD_NUMBER", [40, 160, 300, 36], "invariant"),
      gt("PHONE_IN", [40, 220, 300, 36], "high"),
    ],
  },
  {
    id: "payments_upi_1",
    slice: "payments",
    description: "Payment page: QR code, VPA in text, amount",
    regions: [
      region({
        id: "e1", role: "image", label: null, box: [200, 100, 180, 180],
        source: "vision", confidence: 0.95, evidence: ["visual:qr-detector"],
        visualClass: "QR_BARCODE",
      }),
      text("e2", "Pay to merchant@ybl", [200, 300, 200, 22]),
      text("e3", "Amount due Rs. 2,000", [200, 340, 200, 22]),
    ],
    groundTruth: [
      gt("QR_BARCODE", [200, 100, 180, 180], "invariant"),
      gt("UPI_VPA", [200, 300, 200, 22], "high"),
      gt("AMOUNT", [200, 340, 200, 22], "high"),
    ],
  },
  {
    id: "mail_inbox_1",
    slice: "mail",
    description: "Inbox list: sender emails, a phone in a preview, names (Tier 0 gap)",
    regions: [
      text("e1", "From anita.desai@example.com : Quarterly report attached", [40, 100, 600, 22]),
      text("e2", "From hr@company.example.com : call me on 9876543210", [40, 140, 600, 22]),
      text("e3", "From Anita Desai : lunch tomorrow?", [40, 180, 600, 22]),
    ],
    groundTruth: [
      gt("EMAIL", [40, 100, 600, 22], "high"),
      gt("EMAIL", [40, 140, 600, 22], "high"),
      gt("PHONE_IN", [40, 140, 600, 22], "high"),
      gt("PERSON_NAME", [40, 180, 600, 22], "medium", true, "bare name: needs the NER tier"),
    ],
  },
  {
    id: "mail_compose_2",
    slice: "mail",
    description: "Compose: structural recipient field, Aadhaar mentioned in the body",
    regions: [
      input("e1", "To", [40, 100, 400, 32], "ramesh.kumar@gmail.com", {
        structuralClass: "EMAIL",
      }),
      region({
        id: "e2", role: "textbox", label: "Message body", box: [40, 150, 600, 200],
        state: { filled: true },
        rawValue: "As discussed my aadhaar is 9999 4105 7058, please process.",
      }),
    ],
    groundTruth: [
      gt("EMAIL", [40, 100, 400, 32], "high"),
      gt("AADHAAR", [40, 150, 600, 200], "invariant"),
    ],
  },
  {
    id: "commerce_checkout_1",
    slice: "commerce",
    description: "Checkout: structural address fields, card, pincode, order id negative",
    regions: [
      input("e1", "Street Address", [40, 100, 400, 36], "12 MG Road", {
        structuralClass: "ADDRESS",
      }),
      input("e2", "PIN Code", [40, 160, 160, 36], "380015"),
      input("e3", "Card Number", [40, 220, 300, 36], "5555 5555 5555 4444", {
        structuralClass: "CARD_NUMBER",
      }),
      text("e4", "Order 784512369014 : 2 items", [40, 280, 300, 22]),
    ],
    groundTruth: [
      gt("ADDRESS", [40, 100, 400, 36], "high"),
      gt("PIN_CODE", [40, 160, 160, 36], "medium", true, "shield keeps medium visible by design"),
      gt("CARD_NUMBER", [40, 220, 300, 36], "invariant"),
      gt("AADHAAR", [40, 280, 300, 22], "invariant", false, "order id"),
    ],
  },
  {
    id: "social_profile_1",
    slice: "social",
    description: "Profile: face, username visible, DOB with label",
    regions: [
      region({
        id: "e1", role: "image", label: "Profile photo", box: [40, 100, 120, 120],
        source: "vision", confidence: 0.94, evidence: ["visual:face-detector"],
        visualClass: "FACE",
      }),
      text("e2", "DOB: 12/05/1994", [40, 260, 200, 22]),
      text("e3", "Member since 01/2020", [40, 300, 200, 22]),
    ],
    groundTruth: [
      gt("FACE", [40, 100, 120, 120], "invariant"),
      gt("DOB", [40, 260, 200, 22], "high"),
      gt("DOB", [40, 300, 200, 22], "high", false, "membership date, not a birth date"),
    ],
  },
  {
    id: "healthcare_portal_1",
    slice: "healthcare",
    description: "Patient portal: contact details and appointment context",
    regions: [
      text("e1", "Patient contact: 9876543210, mail anita.desai@example.com", [40, 100, 600, 22]),
      text("e2", "Next appointment 24/10/2026 at 10:30", [40, 140, 400, 22]),
    ],
    groundTruth: [
      gt("PHONE_IN", [40, 100, 600, 22], "high"),
      gt("EMAIL", [40, 100, 600, 22], "high"),
      gt("DOB", [40, 140, 400, 22], "high", false, "appointment date, not a birth date"),
    ],
  },
  {
    id: "enterprise_crm_1",
    slice: "enterprise",
    description: "CRM record: customer contact, GSTIN, employee id negative",
    regions: [
      text("e1", "Customer: reach at 9123456789 or sales.lead@client.example.in", [40, 100, 600, 22]),
      text("e2", "GSTIN 27AAPFU0939F1ZV on file", [40, 140, 400, 22]),
      text("e3", "Handled by employee 40100234", [40, 180, 400, 22]),
    ],
    groundTruth: [
      gt("PHONE_IN", [40, 100, 600, 22], "high"),
      gt("EMAIL", [40, 100, 600, 22], "high"),
      gt("GSTIN", [40, 140, 400, 22], "high"),
      gt("BANK_ACCOUNT", [40, 180, 400, 22], "high", false, "8 digit employee id"),
    ],
  },
  {
    id: "hard_cases_1",
    slice: "hard",
    description: "Cross-origin iframe, canvas, split Aadhaar, vehicle plate",
    regions: [
      region({
        id: "e1", role: "iframe", label: null, box: [40, 100, 400, 250],
        source: "vision", confidence: 0.5, evidence: [], explained: false,
      }),
      region({
        id: "e2", role: "canvas", label: null, box: [500, 100, 300, 250],
        source: "vision", confidence: 0.5, evidence: [], explained: false,
      }),
      text("e3", "9999 4105", [40, 400, 90, 20]),
      text("e4", "7058", [140, 400, 45, 20]),
      text("e5", "Vehicle GJ 01 AB 1234 parked in bay 4", [40, 440, 400, 20]),
    ],
    groundTruth: [
      gt("UNEXPLAINED", [40, 100, 400, 250], "invariant", true, "cross-origin iframe"),
      gt("UNEXPLAINED", [500, 100, 300, 250], "invariant", true, "canvas app"),
      gt("AADHAAR", [40, 400, 90, 20], "invariant", true, "left half of split Aadhaar"),
      gt("AADHAAR", [140, 400, 45, 20], "invariant", true, "right half of split Aadhaar"),
      gt("VEHICLE_REG", [40, 440, 400, 20], "high"),
    ],
  },
  {
    id: "adv_formats_1",
    slice: "adversarial",
    description: "Real-world formatting: unicode dashes, dashed cards, unformatted amounts, spaced PAN, lowercase codes",
    regions: [
      text("e1", "Aadhaar on file: 8473\u20132619\u20130458", [40, 100, 400, 22]),
      text("e2", "Card 4539-1488-0343-6467 charged", [40, 140, 400, 22]),
      text("e3", "Fee \u20b92000 payable now", [40, 180, 300, 22]),
      text("e4", "PAN ABCPE 1234 F verified", [40, 220, 300, 22]),
      text("e5", "branch ifsc sbin0005943", [40, 260, 300, 22]),
      text("e6", "Call (+91) 98765-43210 for support", [40, 300, 400, 22]),
    ],
    groundTruth: [
      gt("AADHAAR", [40, 100, 400, 22], "invariant"),
      gt("CARD_NUMBER", [40, 140, 400, 22], "invariant"),
      gt("AMOUNT", [40, 180, 300, 22], "high"),
      gt("PAN", [40, 220, 300, 22], "invariant"),
      gt("IFSC", [40, 260, 300, 22], "high"),
      gt("PHONE_IN", [40, 300, 400, 22], "high"),
    ],
  },
  {
    id: "adv_evasion_2",
    slice: "adversarial",
    description: "Deliberate evasions: spaced digits, obfuscated email, lowercase GSTIN",
    regions: [
      text("e1", "code 5 2 0 9 8 7 1 6 3 4 9 9 noted", [40, 100, 500, 22]),
      text("e2", "backup card 5 5 5 5 5 5 5 5 5 5 5 5 4 4 4 4", [40, 140, 500, 22]),
      text("e3", "write to priya [at] example [dot] com", [40, 180, 400, 22]),
      text("e4", "registered as 27aapfu0939f1zv", [40, 220, 400, 22]),
    ],
    groundTruth: [
      gt("AADHAAR", [40, 100, 500, 22], "invariant", true, "digit-spacing evasion: closed"),
      gt("CARD_NUMBER", [40, 140, 500, 22], "invariant", true, "digit-spacing evasion: closed"),
      gt("EMAIL", [40, 180, 400, 22], "high", true, "obfuscated [at]/[dot]: known gap, needs normalization pass"),
      gt("GSTIN", [40, 220, 400, 22], "high"),
    ],
  },
  {
    id: "hindi_context_3",
    slice: "government",
    description: "Hindi-labelled fields: context words in Devanagari",
    regions: [
      text("e1", "\u092a\u093f\u0928 \u0915\u094b\u0921: 110001", [40, 100, 300, 22]),
      text("e2", "\u0916\u093e\u0924\u093e \u0938\u0902\u0916\u094d\u092f\u093e 123456789012", [40, 140, 400, 22]),
      text("e3", "\u0906\u0927\u093e\u0930 931572486013", [40, 180, 400, 22]),
      text("e4", "\u092e\u094b\u092c\u093e\u0907\u0932 9876501234", [40, 220, 300, 22]),
    ],
    groundTruth: [
      gt("PIN_CODE", [40, 100, 300, 22], "medium", true, "shield keeps medium visible by design"),
      gt("BANK_ACCOUNT", [40, 140, 400, 22], "high"),
      gt("AADHAAR", [40, 180, 400, 22], "invariant"),
      gt("PHONE_IN", [40, 220, 300, 22], "high"),
    ],
  },
  {
    id: "table_kyc_4",
    slice: "government",
    description: "KYC table: labels and values in separate cells on one visual row",
    regions: [
      text("e1", "Aadhaar Number", [40, 100, 160, 22]),
      text("e2", "785093142627", [220, 100, 160, 22]),
      text("e3", "PAN", [40, 140, 160, 22]),
      text("e4", "AABCU9603R", [220, 140, 160, 22]),
      text("e5", "Date of Birth", [40, 180, 160, 22]),
      text("e6", "31/01/1990", [220, 180, 160, 22]),
    ],
    groundTruth: [
      gt("AADHAAR", [220, 100, 160, 22], "invariant", true, "caught by cross-region line scan"),
      gt("PAN", [220, 140, 160, 22], "invariant"),
      gt("DOB", [220, 180, 160, 22], "high", true, "label cell provides the birth context"),
    ],
  },
  {
    id: "adv_negatives_5",
    slice: "adversarial",
    description: "Lookalike negatives in adversarial formats: none may be masked",
    regions: [
      text("e1", "Ref 8473\u20132619\u20130459 issued", [40, 100, 400, 22]),
      text("e2", "txn 4539 1488 0343 6468 logged", [40, 140, 400, 22]),
      text("e3", "code 27AAPFU0939F1ZX invalid", [40, 180, 400, 22]),
      text("e4", "batch 7 8 4 5 1 2 3 6 9 0 1 4 shipped", [40, 220, 500, 22]),
      text("e5", "employee 40100234 assigned", [40, 260, 300, 22]),
    ],
    groundTruth: [
      gt("AADHAAR", [40, 100, 400, 22], "invariant", false, "en-dash 12 digits, fails Verhoeff"),
      gt("CARD_NUMBER", [40, 140, 400, 22], "invariant", false, "fails Luhn"),
      gt("GSTIN", [40, 180, 400, 22], "high", false, "bad check character"),
      gt("AADHAAR", [40, 220, 500, 22], "invariant", false, "spaced order id, fails Verhoeff"),
      gt("BANK_ACCOUNT", [40, 260, 300, 22], "high", false, "8 digit employee id"),
    ],
  },
  {
    id: "media_gallery_6",
    slice: "social",
    description: "Media-heavy page: more faces and codes for visual support",
    regions: [
      region({
        id: "e1", role: "image", label: "Team photo", box: [40, 100, 200, 150],
        source: "vision", confidence: 0.92, evidence: ["visual:face-detector"],
        visualClass: "FACE",
      }),
      region({
        id: "e2", role: "image", label: null, box: [260, 100, 120, 150],
        source: "vision", confidence: 0.9, evidence: ["visual:face-detector"],
        visualClass: "FACE",
      }),
      region({
        id: "e3", role: "image", label: "Event pass", box: [400, 100, 140, 140],
        source: "vision", confidence: 0.94, evidence: ["visual:qr-detector"],
        visualClass: "QR_BARCODE",
      }),
    ],
    groundTruth: [
      gt("FACE", [40, 100, 200, 150], "invariant"),
      gt("FACE", [260, 100, 120, 150], "invariant"),
      gt("QR_BARCODE", [400, 100, 140, 140], "invariant"),
    ],
  },
];
