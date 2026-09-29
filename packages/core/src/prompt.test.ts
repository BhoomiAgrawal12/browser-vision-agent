import { describe, expect, it } from "vitest";
import { defaultRegistry } from "./detectors/recognizers.js";
import { extractPromptAnswers } from "./prompt.js";

const fields = [
  { id: "name", label: "Full Name *" },
  { id: "email", label: "Email address", structuralClass: "EMAIL" as const },
  { id: "phone", label: "Mobile number", structuralClass: "PHONE_IN" as const },
];

describe("extractPromptAnswers", () => {
  it("does not paste unknown later fields into Name when they are absent on this page", () => {
    const result = extractPromptAnswers("Name: Test Person, Unknown field: private detail, email: user@example.test", [{ id: "name", label: "Name" }], defaultRegistry());
    expect(result.answers).toMatchObject([{ fieldId: "name", value: "Test Person" }]);
  });

  it("matches explicitly labelled first and last names without alias collisions", () => {
    const result = extractPromptAnswers("First name: Test, Last name: Person", [{ id: "first", label: "First name" }, { id: "last", label: "Last name" }], defaultRegistry());
    expect(result.answers.map((a) => [a.fieldId, a.value])).toEqual([["first", "Test"], ["last", "Person"]]);
  });

  it("does not guess which unlabelled email address belongs to the field", () => {
    const result = extractPromptAnswers("Use either one@example.test or two@example.test", [{ id: "email", label: "Email" }], defaultRegistry());
    expect(result.answers).toEqual([]);
  });
  it("extracts informal task details into their matching fields locally", () => {
    const taskFields = [
      { id: "name", label: "Name" },
      { id: "email", label: "Email" },
      { id: "city", label: "City" },
      { id: "phone", label: "Phone" },
      { id: "comments", label: "Comments" },
    ];
    const result = extractPromptAnswers(
      "Help me fill out this form, My name is Test User, my main is user@example.test, I live Example City, Phone : 9999999999, Commets : NuLL",
      taskFields,
      defaultRegistry(),
    );

    expect(result.answers.map(({ fieldId, value }) => [fieldId, value])).toEqual([
      ["name", "Test User"],
      ["email", "user@example.test"],
      ["city", "Example City"],
      ["phone", "9999999999"],
      ["comments", "NuLL"],
    ]);
    for (const value of ["Test User", "user@example.test", "Example City", "9999999999", "NuLL"]) {
      expect(result.sanitizedIntent).not.toContain(value);
    }
  });

  it("maps a bare leading name to the unique name field", () => {
    const taskFields = [
      { id: "name", label: "Name" },
      { id: "email", label: "Email" },
      { id: "city", label: "City" },
      { id: "phone", label: "Phone" },
      { id: "comments", label: "Comments" },
    ];
    const result = extractPromptAnswers(
      "Test User, my main is user@example.test, I live Example City, Phone : 9999999999, Commets : NuLL",
      taskFields,
      defaultRegistry(),
    );

    expect(result.answers.map(({ fieldId, value }) => [fieldId, value])).toEqual([
      ["name", "Test User"],
      ["email", "user@example.test"],
      ["city", "Example City"],
      ["phone", "9999999999"],
      ["comments", "NuLL"],
    ]);
    expect(result.sanitizedIntent).not.toContain("Test User");
  });

  it("matches labelled values and removes them from planner intent", () => {
    const result = extractPromptAnswers(
      "Complete the form with name: Ramesh Kumar, email is ramesh@example.test, phone: 9876543210",
      fields,
      defaultRegistry(),
    );

    expect(result.answers.map((answer) => [answer.fieldId, answer.value])).toEqual([
      ["name", "Ramesh Kumar"],
      ["email", "ramesh@example.test"],
      ["phone", "9876543210"],
    ]);
    expect(result.sanitizedIntent).not.toContain("Ramesh Kumar");
    expect(result.sanitizedIntent).not.toContain("ramesh@example.test");
    expect(result.sanitizedIntent).not.toContain("9876543210");
    expect(result.sanitizedIntent).toContain("[provided locally]");
  });

  it("uses typed recognizers when a field value is supplied without a label", () => {
    const result = extractPromptAnswers(
      "Complete the form using ramesh@example.test",
      [{ id: "email", label: "Email address", structuralClass: "EMAIL" }],
      defaultRegistry(),
    );

    expect(result.answers).toMatchObject([
      { fieldId: "email", value: "ramesh@example.test", class: "EMAIL" },
    ]);
    expect(result.sanitizedIntent).toBe("Complete the form using [provided locally]");
  });

  it("does not guess a value from a field mention without an explicit separator", () => {
    const result = extractPromptAnswers(
      "Find the name field and explain what it means",
      [{ id: "name", label: "Name" }],
      defaultRegistry(),
    );

    expect(result.answers).toHaveLength(0);
    expect(result.sanitizedIntent).toBe("Find the name field and explain what it means");
  });

  it("does not mistake task instructions for a bare leading name", () => {
    const result = extractPromptAnswers(
      "Help me fill out this form, user@example.test, Phone: 9999999999",
      [
        { id: "name", label: "Name" },
        { id: "email", label: "Email" },
        { id: "phone", label: "Phone" },
      ],
      defaultRegistry(),
    );

    expect(result.answers.some((answer) => answer.fieldId === "name")).toBe(false);
  });

  it("does not choose between duplicate field targets", () => {
    const result = extractPromptAnswers(
      "Use ramesh@example.test",
      [
        { id: "primary-email", label: "Email address", structuralClass: "EMAIL" },
        { id: "backup-email", label: "Email address", structuralClass: "EMAIL" },
      ],
      defaultRegistry(),
    );

    expect(result.answers).toHaveLength(0);
    expect(result.sanitizedIntent).toBe("Use ramesh@example.test");
  });
});
