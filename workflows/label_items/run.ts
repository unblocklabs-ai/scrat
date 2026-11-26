import type { WorkflowContext } from "../../src/workflow-ctx.ts";

export default async function labelItems(ctx: WorkflowContext) {
  const categories = ctx.item.labelCategories();
  if (!categories.length) {
    throw new Error(`label_items has no label categories configured for ${ctx.trigger.item?.kind ?? "item"}`);
  }
  const saved = ctx.item.savedResult();
  let expectedKey: string;
  let result;
  if (saved?.labelingKey) {
    expectedKey = saved.labelingKey;
    result = saved.result;
  } else {
    const observed = await ctx.item.connect();
    expectedKey = ctx.item.labelKey(observed, categories);
    result = await ctx.item.withCheckout(observed, { prepare: false, labelingCategories: categories }, (ws) =>
      ctx.item.runAgent(ws, {
        files: [],
        contextMode: "change",
        labelCategories: categories,
      }),
    );
  }
  const current = await ctx.item.connect();
  await ctx.item.assertFreshForPublication(current, { labelKey: expectedKey, labelCategories: categories });
  const labels = result.labels;
  ctx.item.assertLabelSelections(labels, categories);
  const desired = labels.map(({ name }) => name);
  const managed = categories.flatMap(({ choices }) => choices.map(({ name }) => name));
  await ctx.item.reconcileLabels({ key: `labels-${expectedKey.slice(0, 32)}`, current, desired, managed });
  return result;
}
