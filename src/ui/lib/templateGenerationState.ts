export type TemplateInputOption =
  | "framework"
  | "baseline"
  | "control_family"
  | "selected_controls"
  | "selected_stigs"
  | "environment_archetype";

/**
 * The name each input carries on the page, so the blocking message names the
 * field a reader can actually see. Emitting the option key put "framework" in
 * front of a control labelled "Catalog or program" - a raw identifier in
 * user-facing copy, which the design principles rule out.
 */
const INPUT_OPTION_LABELS: Record<TemplateInputOption, string> = {
  framework: "Catalog or program",
  baseline: "Baseline",
  control_family: "Control family",
  selected_controls: "Controls",
  selected_stigs: "STIG benchmarks",
  environment_archetype: "Environment",
};

export function templateInputLabel(option: string): string {
  return INPUT_OPTION_LABELS[option as TemplateInputOption] || option;
}

type TemplateDefinition = {
  name: string;
  input_options: TemplateInputOption[];
  required_input_options?: TemplateInputOption[];
  supported_formats: string[];
};

type TemplateRouteState = {
  framework?: string;
  baseline?: string;
  controlFamily?: string;
  selectedControls?: string[];
  selectedStigs?: string[];
  environment?: string;
  format?: string;
};

type SelectionOptions = Partial<
  Record<TemplateInputOption, ReadonlyArray<string>>
>;

function routeValue(
  routeState: TemplateRouteState,
  option: TemplateInputOption,
): string | string[] {
  switch (option) {
    case "framework":
      return routeState.framework || "";
    case "baseline":
      return routeState.baseline || "";
    case "control_family":
      return routeState.controlFamily || "";
    case "selected_controls":
      return routeState.selectedControls || [];
    case "selected_stigs":
      return routeState.selectedStigs || [];
    case "environment_archetype":
      return routeState.environment || "";
  }
}

function hasSelection(value: string | string[]) {
  return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
}

function snapshotId(value: unknown) {
  const input = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `template-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildTemplateGenerationSnapshot({
  template,
  routeState,
  selectionOptions = {},
}: {
  template: TemplateDefinition;
  routeState: TemplateRouteState;
  selectionOptions?: SelectionOptions;
}) {
  const selections = Object.fromEntries(
    template.input_options.map((option) => [option, routeValue(routeState, option)]),
  ) as Record<TemplateInputOption, string | string[]>;
  const required = template.required_input_options || [];
  const missing = required.filter((option) => !hasSelection(selections[option]));
  const invalid = template.input_options.filter((option) => {
    const allowed = selectionOptions[option];
    const selection = selections[option];
    if (!allowed || !hasSelection(selection)) return false;
    return Array.isArray(selection)
      ? selection.some((value) => !allowed.includes(value))
      : !allowed.includes(selection);
  });
  const format = template.supported_formats.includes(routeState.format || "")
    ? routeState.format || template.supported_formats[0]
    : template.supported_formats[0];
  const options = {
    templateType: template.name,
    framework: String(selections.framework || ""),
    baseline:
      selections.baseline === "ALL" ? "" : String(selections.baseline || ""),
    controlFamily: String(selections.control_family || ""),
    environment: String(selections.environment_archetype || ""),
    selectedControls: Array.isArray(selections.selected_controls)
      ? selections.selected_controls
      : [],
    selectedStigs: Array.isArray(selections.selected_stigs)
      ? selections.selected_stigs
      : [],
    format,
  };
  const identity = {
    template: template.name,
    selections,
    format,
  };
  return {
    id: snapshotId(identity),
    selections,
    options,
    validation: {
      valid: missing.length === 0 && invalid.length === 0,
      missing,
      invalid,
    },
  };
}

export function resolveTemplateGenerationState(
  snapshot: ReturnType<typeof buildTemplateGenerationSnapshot>,
  result: {
    preview: unknown | null;
    error?: string;
  },
) {
  const previewAvailable = snapshot.validation.valid && Boolean(result.preview);
  const status = snapshot.validation.missing.length
    ? `Choose ${snapshot.validation.missing.map(templateInputLabel).join(" and ")} to enable the download.`
    : snapshot.validation.invalid.length
      ? `Remove invalid inputs: ${snapshot.validation.invalid.map(templateInputLabel).join(", ")}.`
    : result.error || (previewAvailable ? "Preview ready." : "Preview unavailable.");
  return {
    snapshotId: snapshot.id,
    previewAvailable,
    downloadEnabled: previewAvailable,
    status,
  };
}
