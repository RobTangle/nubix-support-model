import type { WebConfiguration } from './api.js';

/** Construye selectores desde configuración del servidor; evita duplicar IDs o etiquetas en HTML. */
export function populatePromptOptions(
  select: HTMLSelectElement,
  configuration: WebConfiguration,
  preferredVersion?: string,
): void {
  const labels = new Map(configuration.prompts?.map((prompt) => [prompt.id, prompt.label]));
  select.replaceChildren();
  for (const version of configuration.promptVersions) {
    const option = select.ownerDocument.createElement('option');
    option.value = version;
    option.textContent = labels.get(version) ?? version;
    option.selected = select.multiple;
    select.append(option);
  }
  if (!select.multiple)
    select.value =
      preferredVersion ?? configuration.defaultPromptVersion ?? configuration.promptVersions[0]!;
}
