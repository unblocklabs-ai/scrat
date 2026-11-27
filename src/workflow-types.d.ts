declare module "scrat" {
  export type WorkflowContext = import("./workflow-ctx.ts").WorkflowContext;
  export type D1ExtractFieldSpec = import("./workflow-ctx.ts").D1ExtractFieldSpec;
  export type D1ExtractAnswer = import("./workflow-ctx.ts").D1ExtractAnswer;
}
