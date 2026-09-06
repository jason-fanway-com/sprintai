// Normalize open_hours for a day into an array of {open,close} windows.
// Handles both the current flat-object shape (Phase 5) and the legacy array
// shape. Single source of truth: chat-sms and public-menu both read the same
// open_hours column and must agree on what it means, or one of them will
// treat a shop as open/closed when the other doesn't.
export function dayWindows(
  dayHours: { closed?: boolean; open?: string; close?: string } | Array<{ open: string; close: string }> | undefined | null,
): Array<{ open: string; close: string }> {
  if (!dayHours) return [];
  if (Array.isArray(dayHours)) return dayHours;
  // Flat-object shape: { closed, open, close }
  if (dayHours.closed || !dayHours.open || !dayHours.close) return [];
  return [{ open: dayHours.open, close: dayHours.close }];
}
