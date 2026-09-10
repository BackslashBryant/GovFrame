import { ALL_NAV_ITEMS } from "../lib/navigation";
import { PRODUCT_DEFINITION, PRODUCT_FOOTER_NOTICE } from "../../shared/product-identity";
import type { ViewState } from "../lib/viewState";
import { AppLink } from "./AppLink";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

function formatBuildDate(value: string) {
  return value ? DATE_FORMATTER.format(new Date(value)) : "local development build";
}

const PRODUCT_RELEASE_DATE = formatBuildDate(
  import.meta.env.VITE_CONTROL_ATLAS_RELEASE_DATE,
);
const SOURCE_DATA_DATE = formatBuildDate(
  import.meta.env.VITE_CONTROL_ATLAS_SOURCE_DATA_DATE,
);

export function SiteFooter(props: {
  onNavigate: (view: ViewState["view"], patch?: Partial<ViewState>) => void;
  /**
   * Error states suppress the donation ask. Everything else in the footer
   * still helps on a failed lookup - "Report a problem" especially - but
   * asking for money at the moment something did not work reads badly.
   */
  suppressSupportAsk?: boolean;
}) {
  return (
    <footer className="site-footer mt-[64px] border-t border-[var(--ca-border-strong)] bg-[var(--ca-surface-raised)] py-[48px] px-[24px]">
      <div className="site-footer-layout w-full max-w-[1280px] mx-auto">
        <div className="site-footer-identity">
          <strong className="block font-mono uppercase tracking-wider text-[11px] mb-[12px] text-[var(--ca-text)]">Control Atlas</strong>
          <p className="text-[var(--ca-text-muted)] text-[13px] max-w-[400px]">{PRODUCT_DEFINITION}</p>
        </div>
        <nav aria-label="Footer navigation" className="site-footer-navigation">
          <strong className="block font-mono uppercase tracking-wider text-[11px] mb-[16px] text-[var(--ca-text)]">Navigate</strong>
          <ul className="site-footer-navigation-list">
            {ALL_NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <AppLink
                  className="footer-link text-[var(--ca-text-muted)] hover:text-[var(--ca-secondary)] text-[13px] transition-colors"
                  onNavigate={props.onNavigate}
                  patch={item.patch}
                  view={item.view}
                >
                  {item.label}
                </AppLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="site-footer-contribute">
          <strong className="block font-mono uppercase tracking-wider text-[11px] mb-[16px] text-[var(--ca-text)]">Contribute</strong>
          <p className="text-[var(--ca-text-muted)] text-[13px] mb-[12px]">Open source under the MIT license.</p>
          <a className="footer-link block mt-[12px] text-[var(--ca-text-muted)] hover:text-[var(--ca-secondary)] text-[13px]" href="https://github.com/rambulls/control-atlas/issues/new?template=submit-resource.yml" rel="noopener noreferrer" target="_blank">Submit resource</a>
          <a className="footer-link block mt-[12px] text-[var(--ca-text-muted)] hover:text-[var(--ca-secondary)] text-[13px]" href="https://github.com/rambulls/control-atlas/issues/new?template=report-broken-link.yml" rel="noopener noreferrer" target="_blank">Report a problem</a>
          {props.suppressSupportAsk ? null : (
            <a className="footer-link block mt-[12px] text-[var(--ca-text-muted)] hover:text-[var(--ca-secondary)] text-[13px]" href="https://buymeacoffee.com/ram.bulls" rel="noopener noreferrer" target="_blank">Support Control Atlas</a>
          )}
        </div>
      </div>
      <div className="site-footer-release max-w-[1280px] mx-auto border-t border-[var(--ca-border)] pt-[24px] flex flex-wrap gap-x-[24px] gap-y-[8px]">
        <p className="text-[var(--ca-text-subtle)] text-[12px]">{PRODUCT_FOOTER_NOTICE}</p>
        <p className="text-[var(--ca-text-subtle)] text-[12px]">Product release {PRODUCT_RELEASE_DATE}.</p>
        <p className="text-[var(--ca-text-subtle)] text-[12px]">Source data built {SOURCE_DATA_DATE}.</p>
        <AppLink className="footer-link text-[var(--ca-text-subtle)] hover:text-[var(--ca-secondary)] text-[12px]" onNavigate={props.onNavigate} view="sources">Source attribution</AppLink>
        <a className="footer-link text-[var(--ca-text-subtle)] hover:text-[var(--ca-secondary)] text-[12px]" href="https://rambulls.pages.dev/" rel="noopener noreferrer">A RAM.BULLS project</a>
      </div>
    </footer>
  );
}
