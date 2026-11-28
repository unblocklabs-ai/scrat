declare module "scrat" {
  export type WorkflowContext = import("./workflow-ctx.ts").WorkflowContext;
  export type D1ExtractFieldSpec = import("./workflow-ctx.ts").D1ExtractFieldSpec;
  export type D1ExtractAnswer = import("./workflow-ctx.ts").D1ExtractAnswer;
  export type LighthouseOptions = import("./lighthouse.ts").LighthouseOptions;
  export type StorefrontLighthouseSummary = import("./lighthouse.ts").StorefrontLighthouseSummary;
  export type LighthouseComparison = import("./lighthouse.ts").LighthouseComparison;
  export type UploadedImage = import("./cloudflare-images.ts").UploadedImage;
}
