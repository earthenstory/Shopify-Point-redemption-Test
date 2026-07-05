export function formBoolean(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "1";
}

export function formNumber(value: FormDataEntryValue | null): number {
  return Number(String(value ?? "").trim());
}
