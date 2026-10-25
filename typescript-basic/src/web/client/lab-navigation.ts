export type LabView = 'support' | 'evaluations' | 'history' | 'guide';

const destinations: Record<LabView, string> = {
  support: 'ticket-title',
  evaluations: 'evaluation-panel',
  history: 'history-panel',
  guide: 'guide-panel',
};

/** Cambia la vista sin desmontar formularios ni interrumpir el stream o el trabajo del servidor. */
export class LabNavigation {
  constructor(private readonly document: Document) {}

  initialize(): void {
    this.document.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      const link = target?.closest<HTMLAnchorElement>('a[data-lab-link]');
      if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      this.open(this.viewFor(link.hash));
    });
    this.document.defaultView?.addEventListener('hashchange', () => this.showCurrent(false));
    this.document.defaultView?.addEventListener('popstate', () => this.showCurrent(false));
    this.showCurrent(false);
  }

  open(view: LabView): void {
    this.document.defaultView?.history.pushState(null, '', `#${destinations[view]}`);
    this.showCurrent(true);
  }

  private viewFor(hash: string): LabView {
    if (hash === '#main-content')
      return (
        (this.document.querySelector<HTMLElement>('[data-lab-view]:not([hidden])')?.dataset
          .labView as LabView | undefined) ?? 'support'
      );
    if (hash === '#evaluation-panel') return 'evaluations';
    if (hash === '#history-panel') return 'history';
    if (hash === '#guide-panel') return 'guide';
    return 'support';
  }

  private showCurrent(focus: boolean): void {
    const hash = this.document.defaultView?.location.hash ?? '';
    const view = this.viewFor(hash);
    for (const section of this.document.querySelectorAll<HTMLElement>('[data-lab-view]'))
      section.hidden = section.dataset.labView !== view;
    for (const link of this.document.querySelectorAll<HTMLAnchorElement>('nav [data-lab-link]')) {
      if (this.viewFor(link.hash) === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (focus) {
      const target = this.document.getElementById(destinations[view]);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
    }
  }
}
