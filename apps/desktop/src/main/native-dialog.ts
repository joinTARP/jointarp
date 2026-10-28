import { Utils } from "electrobun/main";

export interface PathPickerOptions {
  title?: string;
  defaultPath?: string;
  properties: readonly string[];
  filters?: readonly { name: string; extensions: readonly string[] }[];
}
export async function showPathPicker(options: PathPickerOptions) {
  const filePaths = await Utils.openFileDialog({
    startingFolder: options.defaultPath ?? "~/",
    canChooseFiles: options.properties.includes("openFile"),
    canChooseDirectory: options.properties.includes("openDirectory"),
    allowsMultipleSelection: false,
    allowedFileTypes: options.filters?.flatMap((filter) => filter.extensions).join(",") ?? "*",
  });
  return { canceled: filePaths.length === 0, filePaths };
}
export function documentsPath(): string {
  return Utils.paths.documents;
}
