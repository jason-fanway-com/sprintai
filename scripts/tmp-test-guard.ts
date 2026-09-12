import { inferCategory } from "../supabase/functions/_shared/archetypes.ts";
const mkItem = (name: string) => ({
  id: name, name, category: "Hot Subs", description: "",
  nameSlotChoices: null, descriptionSlotChoices: null,
  extractedGroups: [], categoryCandidateGroups: [],
});
const result = inferCategory("Hot Subs", [mkItem("Steak Sub")] as any);
console.log("slotOutcomes:", JSON.stringify(result.slotOutcomes, null, 2));
console.log("questions:", JSON.stringify(result.questions, null, 2));
