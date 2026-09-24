// templates.ts — every string a customer can read. Nothing else in the engine
// builds customer-facing text. Money arrives here already formatted by price.ts.

export interface Voice { shop_name: string; phone_display: string | null }

const SIZE_ORDER = ["personal", "small", "medium", "large", "xlarge", "sheet", "cup", "bowl", "half", "whole", "regular"];
export function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => (SIZE_ORDER.indexOf(a) + 100) % 100 - (SIZE_ORDER.indexOf(b) + 100) % 100);
}
export function title(s: string): string { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }
export function orList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}
export function numbered(items: string[]): string { return items.map((s, i) => `${i + 1}) ${s}`).join("\n"); }

export const T = {
  greeting: (v: Voice) => `Hi, this is ${v.shop_name}.`,

  // acknowledgements
  ackLine: (qty: number, name: string, money: string | null, extras: string[]) =>
    `${qty} × ${name}${extras.length ? ` (${extras.join(", ")})` : ""}${money ? `  ${money}` : ""}`,
  ackAdded: (rows: string[]) => (rows.length === 1 ? `Added ${rows[0].trim()}.` : `Added:\n${rows.join("\n")}`),
  ackUpdated: (rows: string[]) => (rows.length === 1 ? `Updated: ${rows[0].trim()}.` : `Updated:\n${rows.join("\n")}`),
  ackRemoved: (names: string[]) => `Removed ${orList(names).replace(" or ", " and ")}.`,
  ackFulfillment: (f: "pickup" | "delivery") => (f === "pickup" ? "Got it, pickup." : "Got it, delivery."),
  ackAddress: (text: string) => `Delivery to ${text}.`,
  ackTip: (money: string) => `Tip: ${money}.`,
  ackNoted: (notes: string[]) => `Noted for the kitchen: ${notes.join(", ")}.`,
  ackProgress: (picks: string[], name: string) => `${picks.join(", ")} for the ${name}.`,
  ackPending: (items: string[]) => `Got the ${orList(items).replace(" or ", " and ")} too. One question about ${items.length > 1 ? "those" : "it"} next.`,
  notOnMenu: (about: string) => `I don't see ${about} on the menu.`,

  // declines and automatic resolutions
  noSuchLine: (span?: string) => (span ? `I don't see "${span}" in your order.` : `I don't see that in your order.`),
  nothingToRemove: () => `Your order is empty, nothing to remove.`,
  addressNotFound: (text: string) => `I couldn't find "${text}". Can you check it, or give a nearby cross street?`,
  addressOutOfZone: (text: string) => `${text} is outside our delivery area.`,
  droppedLine: (span: string) => `I'll leave "${span}" off for now.`,
  addressToPickup: () => `I'll set this up for pickup instead.`,
  tipZero: () => `No tip added.`,
  tipOutOfRange: () => `That tip amount doesn't look right.`,

  // questions, by repeat count
  fulfillment: (c: number) => [
    `Pickup or delivery?`,
    `Is this order for pickup or delivery?`,
    `Reply PICKUP or DELIVERY to continue.`,
  ][Math.min(c, 2)],
  address: (c: number) => [
    `What's the delivery address?`,
    `I need a street address for delivery, like 123 Main St, Allentown.`,
    `Text the delivery address, or reply PICKUP to pick it up instead.`,
  ][Math.min(c, 2)],
  itemsEmpty: (c: number) => [
    `What can I get for you?`,
    `What would you like to order? You can name items, like "2 large pepperoni pizzas".`,
    `Name an item from the menu, or reply MENU to hear the categories.`,
  ][Math.min(c, 2)],
  itemsMore: (c: number) => [
    `Anything else?`,
    `Anything else, or is that everything?`,
    `Reply DONE if that's everything, or name another item.`,
  ][Math.min(c, 2)],
  tip: (c: number) => [
    `Add a tip for your driver? Reply a percent like 15 or 20, a dollar amount, or 0.`,
    `Tip amount? Reply 15, 20, a dollar amount like $5, or 0 for none.`,
    `Reply 0 for no tip, or a number for a percent.`,
  ][Math.min(c, 2)],
  confirmAsk: (c: number) => [
    `Reply YES to get your payment link, or tell me what to change.`,
    `Reply YES to pay, or tell me what to change.`,
    `Reply YES to get your payment link, or NO to change something.`,
  ][Math.min(c, 2)],
  readbackHeader: (f: "pickup" | "delivery" | null, address: string | null) =>
    f === "delivery" && address ? `Here's your order for delivery to ${address}:` : `Here's your order for pickup:`,
  moneyLine: (parts: string[]) => parts.join(" · "),
  handoff: (url: string | null) => (url ? `Pay here: ${url}` : `I couldn't create your payment link just now.`),
  checkoutFailed: () => `I couldn't create your payment link just now. Reply YES to try again.`,
  // the same wait the paid receipt promises (index.ts): pickup 10-15 min, delivery 30-45 min
  afterPay: (delivery: boolean) => delivery ? `It'll be on its way about 30-45 minutes after you pay.` : `We'll have it ready about 10-15 minutes after you pay. We look forward to seeing you.`,

  lineUnresolved: (span: string, c: number) => [
    `I couldn't find "${span}" on the menu. What would you like instead?`,
    `Still nothing for "${span}". Name another item, or reply SKIP to leave it off.`,
    `Reply SKIP to leave "${span}" off, or name a menu item.`,
  ][Math.min(c, 2)],
  // Jason, 2026-09-20: a kind question always says what the choices are.
  whatKind: (noun: string, _c: number, kinds: string[]) => {
    const shown = kinds.slice(0, 10).map(title);
    const more = kinds.length - shown.length;
    return `What kind of ${noun}? We have ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
  },
  whatSize: (name: string, sizes: string[]) => `What size ${name}? ${orList(sizes.map(title))}?`,
  whichOne: (names: string[]) => `Which one?\n${numbered(names)}`,
  whichOneMore: (shown: number, total: number) => `Reply a number, or say more of the name. (${shown} of ${total} shown)`,
  slot: (itemName: string, groupPrompt: string, choices: string[], c: number) => {
    const list = c >= 1 || choices.length <= 5 ? ` ${orList(choices)}?` : ` For example ${choices.slice(0, 3).join(", ")}. Reply OPTIONS to hear them all.`;
    return `${itemName}: ${groupPrompt}?${list}`;
  },
  omission: (spans: string[]) => `Did you also want ${orList(spans).replace(" or ", " and ")}? Reply YES or NO.`,
  picks: (itemName: string, remaining: number, total: number, unit: string, flavors: string[], c: number) => {
    const list = flavors.length <= 12 || c >= 1 ? ` Options: ${flavors.join(", ")}.` : ` For example ${flavors.slice(0, 4).join(", ")}. Reply OPTIONS to hear them all.`;
    const lead = remaining === total ? `${itemName}: which ${unit}s?` : `${itemName}: ${total - remaining} of ${total} picked. Which ${remaining} more?`;
    return `${lead} Tell me how many of each, like "6 plain, 6 everything".${list}`;
  },
  lineRef: (names: string[]) => `Which one do you mean?\n${numbered(names)}`,

  // info
  cartEmpty: () => `Your order is empty so far.`,
  cartHeader: () => `Your order so far:`,
  itemInfo: (name: string, money: string | null, options: string[], description: string | null = null) =>
    `${name}${description ? `: ${description}.` : ""}${money ? ` ${money}.` : description ? "" : "."}${options.length ? ` ${options.join("; ")}.` : ""}`.replace(/^([^.]*)\.\s+Sizes/, "$1. Sizes"),
  listInfo: (names: string[]) => `Options: ${names.slice(0, 16).join(", ")}${names.length > 16 ? `, and ${names.length - 16} more` : ""}.`, // "OPTIONS" for a 13-flavor slot shows all 13
  menuCategories: (cats: string[]) => `Categories: ${cats.join(", ")}. Name an item or a category.`,
  unknownInfo: () => `I can help you order. Name an item or ask about one.`,
  human: (v: Voice) => (v.phone_display ? `You can reach the shop at ${v.phone_display}.` : `Someone from the shop will follow up with you.`),
  cancelled: () => `Okay, I've cancelled that order. Text us anytime to start a new one.`,
  startedOver: () => `Okay, starting fresh.`,
  noEta: () => `Pickup orders are usually ready in about 10-15 minutes, delivery in about 30-45.`,
  unclear: (c = 0) => [`Sorry, I didn't catch that.`, `I didn't follow that.`, `I can take your order here. Name an item, ask about the menu, or reply DONE when you're finished.`][Math.min(c, 2)],
  fallback: () => `Sorry, something went wrong on our end. Please text again in a moment.`,
};

export const GROUP_PROMPTS: Record<string, string> = {
  temp: "how would you like it cooked",
  temperature: "how would you like it cooked",
  size: "what size",
  bread: "what bread",
  dressing: "which dressing",
  sauce: "which sauce",
  cheese: "which cheese",
  side: "which side",
  toppings: "which toppings",
  flavor: "which flavor",
  crust: "which crust",
};
const GENERIC_GROUP = new Set(["choiceof", "choice", "choices", "option", "options", "select", "selection", "pick", "type"]);
export function groupPrompt(groupName: string): string {
  const k = groupName.toLowerCase().replace(/[^a-z]/g, "");
  if (GENERIC_GROUP.has(k)) return "which would you like";
  for (const key of Object.keys(GROUP_PROMPTS)) if (k.includes(key)) return GROUP_PROMPTS[key];
  return `which ${groupName.toLowerCase()}`;
}
