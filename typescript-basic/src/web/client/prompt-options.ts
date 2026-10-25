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

/** Checkboxes visibles: comparar versiones no debería requerir conocer Ctrl/Cmd + clic. */
export function populatePromptChoices(
  fieldset: HTMLFieldSetElement,
  configuration: WebConfiguration,
): void {
  const labels = new Map(configuration.prompts?.map((prompt) => [prompt.id, prompt.label]));
  const legend = fieldset.ownerDocument.createElement('legend');
  legend.textContent = 'Versiones que querés comparar';
  fieldset.replaceChildren(legend);
  for (const version of configuration.promptVersions) {
    const label = fieldset.ownerDocument.createElement('label');
    label.className = 'prompt-choice';
    const input = fieldset.ownerDocument.createElement('input');
    input.type = 'checkbox';
    input.name = 'promptVersions';
    input.value = version;
    input.checked = true;
    label.append(input, fieldset.ownerDocument.createTextNode(labels.get(version) ?? version));
    fieldset.append(label);
  }
}
