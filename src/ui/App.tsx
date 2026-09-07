import {
  type ComponentType,
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  DataPendingNotice,
  LoadErrorPanel,
  LoadingStatusPanel,
  OfflineFallbackActions,
} from "./components/LoadStatusPanel";
import {
  CompareSkeleton,
  DetailConnectionsSkeleton,
  LibrarySkeleton,
} from "./components/LibrarySkeleton";
import { SiteFooter } from "./components/SiteFooter";
import { TopNav } from "./components/TopNav";
import { AppLink } from "./components/AppLink";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import {
  OrbitalContextBar,
  orbitalRouteContext,
} from "./components/OrbitalContextBar";
import { userFacingLoadError } from "../app/display-names.mjs";
import type { RuntimeBundle } from "./lib/runtimeLoader";
import { HomePage } from "./pages/HomePage";
import {
  browserReloadClock,
  claimChunkReload,
  isChunkLoadFailure,
} from "./lib/chunkRecovery";
import {
  isStaticViewWithoutBundle,
  requiresFullGraph,
} from "./lib/navigationState";
import { normalizeViewState, type ViewState } from "./lib/viewState";
import { parseHashLocation, serializeHashLocation } from "./lib/hashRoutes";
import { canonicalizeHashLocation } from "./lib/routeIdentity";
import { catalogDisplayNameFor } from "./lib/catalogProfiles";
import {
  recordIdentityPresentationFor,
  recordDisplayTitle,
  recordPublisherName,
  routeDocumentTitle,
} from "./lib/recordTitle";
import { sourceIdentityPresentationFor } from "./lib/sourceIdentity";
import {
  beginRouteTransition,
  completeRouteTransition,
  CLOSE_OVERLAYS_EVENT,
  consumeSearchOverlayOpenRequest,
  notifyRouteCommitted,
  OPEN_SEARCH_OVERLAY_EVENT,
} from "../shared/navigation-events";
import {
  focusRouteHeading,
  nextNavigationKey,
  restoreScrollPosition,
  saveScrollPosition,
  scrollToTop,
} from "./lib/routeOrientation";

/**
 * Wraps a lazy route so a chunk 404 left behind by a deploy reloads the page
 * instead of reporting that the workspace stopped. See chunkRecovery.
 */
function lazyRoute<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((error: unknown) => {
      if (isChunkLoadFailure(error) && claimChunkReload(browserReloadClock())) {
        window.location.reload();
        // The reload replaces this document, so this promise never settles.
        return new Promise<{ default: T }>(() => {});
      }
      throw error;
    }),
  );
}

const AboutPage = lazyRoute(() =>
  import("./pages/AboutPage").then((module) => ({
    default: module.AboutPage,
  })),
);
const AtlasMapPage = lazyRoute(() =>
  import("./pages/AtlasMapPage").then((module) => ({
    default: module.AtlasMapPage,
  })),
);
const ComparePage = lazyRoute(() =>
  import("./pages/ComparePage").then((module) => ({
    default: module.ComparePage,
  })),
);
const CatalogDetailPage = lazyRoute(() =>
  import("./pages/CatalogDetailPage").then((module) => ({
    default: module.CatalogDetailPage,
  })),
);
const ExplorePage = lazyRoute(() =>
  import("./pages/ExplorePage").then((module) => ({
    default: module.ExplorePage,
  })),
);
const ObjectDetailPage = lazyRoute(() =>
  import("./pages/ObjectDetailPage").then((module) => ({
    default: module.ObjectDetailPage,
  })),
);
const PlaybooksPage = lazyRoute(() =>
  import("./pages/PlaybooksPage").then((module) => ({
    default: module.PlaybooksPage,
  })),
);
const SourcesPage = lazyRoute(() =>
  import("./pages/SourcesPage").then((module) => ({
    default: module.SourcesPage,
  })),
);
const StartHerePage = lazyRoute(() =>
  import("./pages/StartHerePage").then((module) => ({
    default: module.StartHerePage,
  })),
);
const TemplatesPage = lazyRoute(() =>
  import("./pages/TemplatesPage").then((module) => ({
    default: module.TemplatesPage,
  })),
);
const CommonsPage = lazyRoute(() =>
  import("./pages/CommonsPage").then((module) => ({
    default: module.CommonsPage,
  })),
);
const CommonsDetailPage = lazyRoute(() =>
  import("./pages/CommonsDetailPage").then((module) => ({
    default: module.CommonsDetailPage,
  })),
);
const SearchOverlay = lazyRoute(() =>
  import("./components/SearchOverlay").then((module) => ({
    default: module.SearchOverlay,
  })),
);
const GlossaryDrawer = lazyRoute(() =>
  import("./components/GlossaryDrawer").then((module) => ({
    default: module.GlossaryDrawer,
  })),
);

// A replace redirect can remount the route shell. Keep its recovery notice
// through that one transition so discarded invalid link settings are visible.
let pendingRouteRecovery = "";

const PROGRESSIVE_SHELL_SELECTORS = [
  "[data-skip-workspace]",
  "[data-static-header]",
  "[data-static-home]",
  "[data-static-route]",
  "[data-static-search]",
];

function releaseProgressiveShell(root: HTMLElement) {
  const routeShell = root.querySelector<HTMLElement>("[data-static-route]");
  const preserveRouteShell =
    root.dataset.routeHydrated !== "true" &&
    Boolean(routeShell && !routeShell.hidden);

  for (const selector of PROGRESSIVE_SHELL_SELECTORS) {
    if (selector === "[data-static-route]" && preserveRouteShell) continue;
    root.querySelector(selector)?.remove();
  }
  root.dataset.progressiveShellReleased = "true";
  delete root.dataset.routeHydrated;
  if (!preserveRouteShell) {
    delete root.dataset.staticRouteActive;
    delete root.dataset.staticRouteKind;
  }
  delete root.dataset.staticSearchActive;
}

function readHashLocation() {
  const value = window.location.hash.replace(/^#/, "") || "/";
  const queryIndex = value.indexOf("?");
  return {
    pathname: queryIndex === -1 ? value : value.slice(0, queryIndex),
    search: queryIndex === -1 ? "" : value.slice(queryIndex),
  };
}

function routeTransitionScope(state: ViewState): string {
  switch (state.view) {
    case "atlas-map":
      return [
        state.view,
        state.node,
        state.atlasAxis,
        state.atlasLimb,
        state.atlasFramework,
        state.atlasBenchmark,
        state.atlasBaseline,
        state.atlasFamily,
        state.atlasRmfStep,
        state.atlasStage,
      ].join(":");
    case "catalog-detail":
      return `${state.view}:${state.catalog}`;
    case "library-detail":
      return `${state.view}:${state.node}`;
    case "commons-detail":
      return `${state.view}:${state.id}`;
    case "sources":
      return `${state.view}:${state.source}`;
    case "patterns":
      return `${state.view}:${state.pattern}`;
    default:
      return state.view;
  }
}

export function App() {
  const [location, setLocation] = useState(readHashLocation);
  const routerNavigate = useCallback(
    (to: string, options?: { replace?: boolean }) => {
      const hash = `#${to.startsWith("/") ? to : `/${to}`}`;
      const target = `${window.location.pathname}${window.location.search}${hash}`;
      if (options?.replace) {
        window.history.replaceState(
          { ...(window.history.state || {}) },
          "",
          target,
        );
      } else {
        saveScrollPosition();
        window.history.pushState(
          { controlAtlasInternalNavigation: true, caNavKey: nextNavigationKey() },
          "",
          target,
        );
      }
      notifyRouteCommitted();
      setLocation(readHashLocation());
    },
    [],
  );
  const [viewState, setViewState] = useState<ViewState>(() =>
    parseHashLocation(location.pathname, location.search),
  );
  // Latest URL-derived state, updated synchronously by navigate() and the
  // location effect, ahead of viewState's own commit. The runtime-load effect
  // below reads this ref instead of viewState so it always sees the most
  // recent navigation even if its own dependencies haven't re-run yet.
  const latestNavStateRef = useRef<ViewState>(viewState);
  // Tracks which runtimeScopeKey was active when the current bundle was last
  // committed, so onSearchReady can decide whether retaining a graphReady
  // bundle from a prior route is safe or would silently deliver stale data.
  const bundleScopeKeyRef = useRef<string>("");
  const [bundle, setBundle] = useState<RuntimeBundle | null>(null);
  const [loadError, setLoadError] = useState<string>("");
  const [loadSlow, setLoadSlow] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [glossaryFocusTermId, setGlossaryFocusTermId] = useState("");
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);
  const [graphRequested, setGraphRequested] = useState(false);
  const [routeRecovery, setRouteRecovery] = useState("");
  const [chromeReady, setChromeReady] = useState(false);

  const closeOverlays = useCallback(() => {
    window.dispatchEvent(new Event(CLOSE_OVERLAYS_EVENT));
    setSearchOverlayOpen(false);
    setHelpOpen(false);
    setGlossaryFocusTermId("");
  }, []);

  const openSearchOverlay = useCallback(() => {
    window.dispatchEvent(new Event(CLOSE_OVERLAYS_EVENT));
    setHelpOpen(false);
    setGlossaryFocusTermId("");
    setSearchOverlayOpen(true);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setChromeReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    root.dataset.reactShellReady = chromeReady ? "true" : "false";
    root.dataset.reactActive = chromeReady ? "true" : "false";
    if (chromeReady) releaseProgressiveShell(root);
  }, [chromeReady, viewState.view]);

  useEffect(() => {
    const syncLocation = () => {
      closeOverlays();
      const nextLocation = readHashLocation();
      const nextState = parseHashLocation(nextLocation.pathname, nextLocation.search);
      if (routeTransitionScope(latestNavStateRef.current) !== routeTransitionScope(nextState)) {
        beginRouteTransition("Opening the selected workspace", window.location.hash);
      }
      setLocation(readHashLocation());
    };
    window.addEventListener("hashchange", syncLocation);
    window.addEventListener("popstate", syncLocation);
    return () => {
      window.removeEventListener("hashchange", syncLocation);
      window.removeEventListener("popstate", syncLocation);
    };
  }, [closeOverlays]);

  function requestFullGraph() {
    setGraphRequested((current) => (current ? current : true));
  }

  const runtimeScopeKey =
    viewState.view === "library-detail"
      ? `${viewState.view}:${viewState.node}`
      : viewState.view === "atlas-map"
        ? `${viewState.view}:${viewState.atlasAxis || "landing"}:${viewState.atlasFramework || "none"}:${viewState.atlasBenchmark || "none"}`
      : viewState.view === "catalog-detail"
        ? `${viewState.view}:${viewState.catalog}:${viewState.family || "all"}`
      : viewState.view === "matrix"
          ? `${viewState.view}:${viewState.crosswalk}:${viewState.intent}:${viewState.source}:${viewState.items}:${viewState.target}:${viewState.compareRun}`
        : viewState.view === "templates"
            ? `${viewState.view}:${viewState.buildSection}:${viewState.task}:${viewState.templateType}`
            : viewState.view;

  useEffect(() => {
    let cancelled = false;
    const loadController = new AbortController();
    setLoadSlow(false);
    setLoadError("");
    const runtimeState = latestNavStateRef.current;
    const scopeKey = runtimeScopeKey;

    const needsRuntime =
      runtimeState.view === "search" ||
      !isStaticViewWithoutBundle(runtimeState.view) ||
      searchOverlayOpen;
    if (!needsRuntime) {
      return () => {
        cancelled = true;
      };
    }
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) {
        setLoadSlow(true);
      }
    }, 3000);

    const timeoutTimer = window.setTimeout(() => {
      if (!cancelled) {
        setLoadError(
          "Library data took too long to load. Check your connection and try again.",
        );
      }
    }, 13000);

    import("./lib/runtimeLoader")
      .then(({ loadRuntimeDatasetStaged }) =>
        loadRuntimeDatasetStaged({
          state: runtimeState,
          graphRequested,
          searchOverlayOpen,
          signal: loadController.signal,
          onSearchReady: (result) => {
            if (!cancelled) {
              // A delivered stage proves the connection works: cancel the hard
              // load timers so slow full-graph fetches degrade to the partial
              // bundle instead of stamping an error over usable content.
              window.clearTimeout(slowTimer);
              window.clearTimeout(timeoutTimer);
              setLoadSlow(false);
              startTransition(() => {
                setBundle((current) => {
                  // Only retain a graphReady bundle from the same scope. A
                  // graphReady bundle from a prior route (e.g. Compare) may be
                  // missing data this route needs (e.g. templateRegistry), so
                  // crossing scopes must always commit the fresh result.
                  const sameScopeGraphReady =
                    current?.graphReady && bundleScopeKeyRef.current === scopeKey;
                  const next = runtimeState.view === "catalog-detail"
                    ? result
                    : sameScopeGraphReady
                      ? current
                      : result;
                  bundleScopeKeyRef.current = scopeKey;
                  return current?.atlasSpine && !next.atlasSpine
                    ? { ...next, atlasSpine: current.atlasSpine }
                    : next;
                });
              });
              setLoadError("");
            }
          },
          onFullReady: (result) => {
            if (!cancelled) {
              window.clearTimeout(slowTimer);
              window.clearTimeout(timeoutTimer);
              setLoadSlow(false);
              startTransition(() => {
                setBundle((current) => {
                  bundleScopeKeyRef.current = scopeKey;
                  return current?.atlasSpine && !result.atlasSpine
                    ? { ...result, atlasSpine: current.atlasSpine }
                    : result;
                });
              });
              setLoadError("");
            }
          },
          onError: (error) => {
            if (!cancelled) {
              setLoadError(
                userFacingLoadError(
                  error instanceof Error ? error : new Error(String(error)),
                ),
              );
            }
          },
        }),
      )
      .finally(() => {
        if (!cancelled) {
          window.clearTimeout(slowTimer);
          window.clearTimeout(timeoutTimer);
        }
      });

    return () => {
      cancelled = true;
      loadController.abort();
      window.clearTimeout(slowTimer);
      window.clearTimeout(timeoutTimer);
    };
  }, [
    graphRequested,
    loadAttempt,
    runtimeScopeKey,
    searchOverlayOpen,
  ]);

  function retryLoad() {
    void import("./lib/runtimeLoader").then(({ clearRuntimeArtifactCache }) => {
      clearRuntimeArtifactCache();
      setBundle(null);
      setLoadError("");
      setLoadSlow(false);
      setGraphRequested(false);
      setLoadAttempt((current) => current + 1);
    });
  }

  useEffect(() => {
    const canonical = canonicalizeHashLocation(`${location.pathname}${location.search}`);
    if (canonical.recoveryMessage) {
      pendingRouteRecovery = canonical.recoveryMessage;
    }
    if (canonical.requiresReplace) {
      routerNavigate(canonical.canonicalPath, { replace: true });
      return;
    }
    setRouteRecovery(pendingRouteRecovery);
    pendingRouteRecovery = "";
    const parsed = parseHashLocation(location.pathname, location.search);
    latestNavStateRef.current = parsed;
    // Route changes must commit immediately: wrapping this in startTransition
    // let a same-path, query-only navigation (e.g. switching Explore areas via
    // a direct hash edit, bookmark, or back/forward, not a click) get
    // superseded before it ever painted, leaving the previous area on screen
    // while the URL had already moved on.
    setViewState(parsed);
  }, [location.pathname, location.search, routerNavigate]);

  // Per-route document.title (CATL-61): honest browser-history/bookmark labels,
  // with record pages resolving to the official record name once the graph is
  // loaded.
  const routeEntityName = (() => {
    const activeNodeId =
      viewState.view === "library-detail" || viewState.view === "atlas-map"
        ? viewState.node
        : "";
    const node =
      activeNodeId && bundle
        ? bundle.runtime.getNode(activeNodeId)
        : null;
    if (node && bundle && activeNodeId) {
      const document = bundle.runtime.getLibraryDocument(activeNodeId);
      if (document) {
        const source = bundle.runtime.getSource(document.source_id || node.source_id);
        const catalog = bundle.runtime
          .getCatalogs()
          .find((entry: any) => entry.id === document.catalog_id);
        const publication = catalogDisplayNameFor(
          document.catalog_id || node.metadata?.catalog_id || "",
          catalog?.name || document.catalog_name || "",
        );
        return recordIdentityPresentationFor({
          publisher: recordPublisherName(
            document.publisher_name,
            source?.owner,
            source?.publisher,
            catalog?.display_group,
          ),
          catalogId: document.catalog_id || node.metadata?.catalog_id || "",
          publicationName: publication,
          family: document.control_family || node.metadata?.family || "",
          itemId: document.item_id || node.metadata?.item_id || node.label || "",
          title: document.title || node.metadata?.title || "",
          objectType: document.object_type || node.node_type || "",
          metadata: {
            identity_category: document.identity_category || node.metadata?.identity_category,
          },
        }).browserTitle;
      }
      return recordDisplayTitle(node);
    }
    if (viewState.view === "commons-detail") {
      return bundle?.commonsDataset?.resources.find((resource) => resource.id === viewState.id)?.name || "";
    }
    if (viewState.view === "sources" && viewState.source && bundle) {
      const source = bundle.runtime.getSource(viewState.source);
      return source
        ? sourceIdentityPresentationFor(source).primaryName
        : "Source not found";
    }
    return "";
  })();

  useEffect(() => {
    const node =
      viewState.view === "library-detail" && viewState.node && bundle
        ? bundle.runtime.getNode(viewState.node)
        : null;
    document.title = routeDocumentTitle(viewState, node, routeEntityName);
    if (
      (viewState.view === "library-detail" ||
        viewState.view === "atlas-map" ||
        (viewState.view === "sources" && Boolean(viewState.source))) &&
      routeEntityName
    ) {
      const progressiveTitle = document.querySelector<HTMLElement>(
        "[data-static-route-title]",
      );
      if (progressiveTitle) progressiveTitle.textContent = routeEntityName;
    }
  }, [viewState, bundle, routeEntityName]);

  useEffect(() => {
    if (viewState.view !== "search") return;
    const status = document.querySelector<HTMLElement>(
      "[data-static-search-status]",
    );
    if (!status) return;
    status.textContent = loadError
      ? "Library data is unavailable. Try again below."
      : bundle
        ? "Search is ready."
        : "Loading the Library…";
  }, [bundle, loadError, viewState.view]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearchOverlay();
      }
    };
    // The Home route boots without this component mounted at all (its
    // shortcuts are advertised on a static shell React hasn't rendered yet),
    // so main.tsx boots React on Ctrl+K and fires this once mounted instead.
    const onOpenSearchOverlay = () => {
      consumeSearchOverlayOpenRequest();
      openSearchOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_SEARCH_OVERLAY_EVENT, onOpenSearchOverlay);
    if (consumeSearchOverlayOpenRequest()) {
      openSearchOverlay();
    }
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_SEARCH_OVERLAY_EVENT, onOpenSearchOverlay);
    };
  }, [openSearchOverlay]);

  const pushNavigationRef = useRef(false);

  function navigate(
    nextView: ViewState["view"],
    patch: Partial<ViewState> = {},
    reset = false,
  ) {
    closeOverlays();
    const current = latestNavStateRef.current;
    const nextState = normalizeViewState(nextView, {
      ...(!reset && current.view === nextView
        ? (current as Record<string, unknown>)
        : {}),
      ...(patch as Record<string, unknown>),
    } as Partial<ViewState>);
    const nextLocation = serializeHashLocation(nextState);
    if (nextLocation === serializeHashLocation(current)) return;
    const changesWorkspace = routeTransitionScope(current) !== routeTransitionScope(nextState);
    if (changesWorkspace) {
      // The transition is presentation state. A stale or duplicate visual
      // transition must never veto the underlying route change.
      beginRouteTransition("Opening the selected workspace", nextLocation);
    }
    if (changesWorkspace) pushNavigationRef.current = true;
    latestNavStateRef.current = nextState;
    routerNavigate(nextLocation);
    if (changesWorkspace) scrollToTop();
  }

  // The global keydown listener is registered once with no deps; it reaches the
  // current navigate through this ref rather than re-subscribing every render.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  function openNode(nodeId: string) {
    navigate("library-detail", { node: nodeId });
  }

  function openNodeByItemId(itemId: string) {
    if (!bundle) {
      navigate("search", { query: itemId });
      return;
    }
    const match =
      bundle.runtime
        .searchLibrary(itemId)
        .find((entry: any) => entry.item_id === itemId) ||
      bundle.runtime.searchLibrary(itemId)[0];
    if (match) {
      openNode(match.id);
    } else {
      navigate("retired", { query: itemId });
    }
  }

  function openGlossary(termId = "") {
    window.dispatchEvent(new Event(CLOSE_OVERLAYS_EVENT));
    setSearchOverlayOpen(false);
    setGlossaryFocusTermId(termId);
    setHelpOpen(true);
  }

  const canRenderWithoutBundle = isStaticViewWithoutBundle(viewState.view);
  const hasRequiredRouteArtifacts =
    viewState.view !== "atlas-map" || Boolean(bundle?.atlasSpine);
  const hasRequiredSearchArtifacts =
    viewState.view !== "atlas-map" || Boolean(bundle?.librarySearchReady);
  const readyState = loadError
    ? "error"
    : canRenderWithoutBundle && viewState.view !== "search"
      ? "true"
    : bundle?.routeReady && hasRequiredRouteArtifacts && hasRequiredSearchArtifacts &&
        (!requiresFullGraph(viewState) || bundle.graphReady)
      ? "true"
      : bundle
        ? "partial"
        : "false";
  const showWorkspaceContent =
    (Boolean(bundle) && hasRequiredRouteArtifacts) ||
    canRenderWithoutBundle ||
    viewState.view === "search";
  const routeContext = orbitalRouteContext(viewState, routeEntityName);

  useEffect(() => {
    let completionFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      completionFrame = window.requestAnimationFrame(completeRouteTransition);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(completionFrame);
    };
  }, [viewState]);

  useEffect(() => {
    if (!pushNavigationRef.current) {
      restoreScrollPosition();
      return;
    }
    pushNavigationRef.current = false;
    const frame = focusRouteHeading();
    return () => window.cancelAnimationFrame(frame);
  }, [viewState]);

  return (
    <>
      <a
        className="skip-link"
        href="#workspace"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("workspace")?.focus();
        }}
      >
        Skip to workspace
      </a>
      {chromeReady ? <TopNav
        onNavigate={navigate}
        onOpenSearch={openSearchOverlay}
        viewState={viewState}
      /> : null}
      {chromeReady ? <OrbitalContextBar entityName={routeEntityName} onNavigate={navigate} state={viewState} /> : null}

      <main id="workspace" tabIndex={-1}>
        {routeRecovery ? (
          <p className="route-recovery" role="status">{routeRecovery}</p>
        ) : null}
        <section
          aria-busy={readyState === "false"}
          aria-live="polite"
          className="app-shell"
          data-app-ready={readyState}
          data-depth={routeContext.depth}
          data-has-subject={
            viewState.view === "atlas-map" && Boolean(viewState.node)
              ? "true"
              : "false"
          }
          data-mode={routeContext.mode}
          data-view={viewState.view}
          id="app"
        >
          {showWorkspaceContent ? (
            <RouteErrorBoundary
              onNavigate={navigate}
              resetKey={`${runtimeScopeKey}:${loadAttempt}`}
            >
              <Suspense fallback={<LoadingStatusPanel slow={false} suspensePending />}>
                <AppContent
                  bundle={bundle}
                  loadError={loadError}
                  loadSlow={loadSlow}
                  onNavigate={navigate}
                  onOpenGlossary={openGlossary}
                  onOpenNode={openNode}
                  onOpenNodeByItemId={openNodeByItemId}
                  onOpenSearch={openSearchOverlay}
                  onRequestFullGraph={requestFullGraph}
                  onRetryLoad={retryLoad}
                  state={viewState}
                />
              </Suspense>
            </RouteErrorBoundary>
          ) : loadError ? (
            <LoadErrorPanel message={loadError} onRetry={retryLoad}>
              <OfflineFallbackActions onNavigate={(view) => navigate(view)} />
            </LoadErrorPanel>
          ) : (
            <LoadingStatusPanel slow={loadSlow}>
              <OfflineFallbackActions onNavigate={(view) => navigate(view)} />
            </LoadingStatusPanel>
          )}
        </section>
      </main>

      {chromeReady ? (
        <SiteFooter
          onNavigate={navigate}
          suppressSupportAsk={
            viewState.view === "not-found"
            || viewState.view === "retired"
            // A record id that resolves to nothing renders the not-found view
            // inside the library-detail route, so gating on the route alone
            // left the donation ask on the failed lookup - the one place the
            // review named it as poorly timed.
            || (viewState.view === "library-detail"
              && Boolean(bundle)
              && !bundle?.runtime.getNode(viewState.node))
          }
        />
      ) : null}

      {searchOverlayOpen ? (
        <RouteErrorBoundary onNavigate={navigate} resetKey={`search:${runtimeScopeKey}:${loadAttempt}`}>
          <Suspense fallback={null}>
            <SearchOverlay
              bundle={bundle}
              onNavigate={navigate}
              onOpenChange={setSearchOverlayOpen}
              onOpenNode={openNode}
              open
            />
          </Suspense>
        </RouteErrorBoundary>
      ) : null}

      {helpOpen ? (
        <RouteErrorBoundary onNavigate={navigate} resetKey={`glossary:${runtimeScopeKey}:${loadAttempt}`}>
          <Suspense fallback={null}>
            <GlossaryDrawer
              bundle={bundle}
              focusTermId={glossaryFocusTermId}
              onNavigate={navigate}
              onOpenNode={openNode}
              open
              setOpen={(open) => {
                setHelpOpen(open);
                if (!open) {
                  setGlossaryFocusTermId("");
                }
              }}
            />
          </Suspense>
        </RouteErrorBoundary>
      ) : null}
    </>
  );
}

function AppContent(props: {
  bundle: RuntimeBundle | null;
  loadError: string;
  loadSlow: boolean;
  state: ViewState;
  onNavigate: (view: ViewState["view"], patch?: Partial<ViewState>) => void;
  onOpenNode: (nodeId: string) => void;
  onOpenNodeByItemId: (itemId: string) => void;
  onOpenSearch: () => void;
  onRequestFullGraph: () => void;
  onOpenGlossary: (termId?: string) => void;
  onRetryLoad: () => void;
}) {
  const {
    bundle,
    loadError,
    loadSlow,
    state,
    onNavigate,
    onOpenNode,
    onOpenNodeByItemId,
    onOpenSearch,
    onRequestFullGraph,
    onOpenGlossary,
    onRetryLoad,
  } = props;

  const graphReady = Boolean(bundle?.graphReady);
  const loadingCopy = routeLoadingCopy(state.view);

  if (!bundle && state.view === "search") {
    if (loadError) {
      return (
        <LoadErrorPanel message={loadError} onRetry={onRetryLoad}>
          <OfflineFallbackActions onNavigate={(view) => onNavigate(view)} />
        </LoadErrorPanel>
      );
    }
    return <LibrarySkeleton />;
  }

  if (!bundle && !isStaticViewWithoutBundle(state.view)) {
    return (
      <DataPendingNotice
        description={loadingCopy.description}
        onRetry={onRetryLoad}
        slow={loadSlow}
        title={loadingCopy.title}
      />
    );
  }

  if (bundle && !graphReady && requiresFullGraph(state)) {
    if (loadError) {
      return (
        <LoadErrorPanel message={loadError} onRetry={onRetryLoad}>
          <OfflineFallbackActions onNavigate={(view) => onNavigate(view)} />
        </LoadErrorPanel>
      );
    }
    if (state.view === "library-detail") {
      return <DetailConnectionsSkeleton />;
    }
    if (state.view === "matrix") {
      return <CompareSkeleton />;
    }
    return (
      <DataPendingNotice
        description={loadingCopy.description}
        onRetry={onRetryLoad}
        slow={loadSlow}
        title={loadingCopy.title}
      />
    );
  }

  if (state.view === "home") {
    return <HomePage onNavigate={onNavigate} onOpenSearch={onOpenSearch} />;
  }

  if (state.view === "not-found") {
    return (
      <section className="notice">
        <h1>Page not found</h1>
        <p>
          That page could not be found. The link may be incorrect, or the page
          may have moved.
        </p>
        <div className="card-actions">
          <AppLink onNavigate={onNavigate} variant="primary" view="home">
            Go to Home
          </AppLink>
          <details>
            <summary>Try another path</summary>
            <div className="card-actions disclosure-actions">
              <AppLink onNavigate={onNavigate} variant="secondary" view="start-here">Start here</AppLink>
              <AppLink onNavigate={onNavigate} variant="secondary" view="search">Search records</AppLink>
            </div>
          </details>
        </div>
      </section>
    );
  }

  if (state.view === "atlas-map") {
    if (!bundle) {
      return (
        <DataPendingNotice onRetry={onRetryLoad} slow={loadSlow} title="Loading the Atlas" />
      );
    }
    return (
      <AtlasMapPage
        bundle={bundle}
        onNavigate={onNavigate}
        onOpenNode={onOpenNode}
        state={state}
      />
    );
  }

  if (state.view === "library-detail") {
    if (!bundle) {
      return <DataPendingNotice onRetry={onRetryLoad} slow={loadSlow} />;
    }
    return (
      <ObjectDetailPage
        bundle={bundle}
        onNavigate={onNavigate}
        onOpenGlossary={onOpenGlossary}
        onOpenNode={onOpenNode}
        state={state}
      />
    );
  }

  if (state.view === "catalog-detail") {
    if (!bundle) {
      return <DataPendingNotice onRetry={onRetryLoad} slow={loadSlow} title="Loading the Library" />;
    }
    return (
      <CatalogDetailPage
        bundle={bundle}
        onNavigate={onNavigate}
        onOpenNode={onOpenNode}
        state={state}
      />
    );
  }

  if (state.view === "matrix") {
    if (!bundle) {
      return <DataPendingNotice onRetry={onRetryLoad} slow={loadSlow} />;
    }
    return (
      <ComparePage
        bundle={bundle}
        onNavigate={onNavigate}
        onOpenNode={onOpenNode}
        state={state}
      />
    );
  }

  if (state.view === "sources") {
    if (!bundle) {
      return <DataPendingNotice onRetry={onRetryLoad} slow={loadSlow} />;
    }
    return (
      <SourcesPage bundle={bundle} onNavigate={onNavigate} state={state} />
    );
  }

  if (state.view === "commons") {
    return (
      <CommonsPage bundle={bundle} onNavigate={onNavigate} viewState={state} />
    );
  }

  if (state.view === "commons-detail") {
    return (
      <CommonsDetailPage bundle={bundle} onNavigate={onNavigate} viewState={state} />
    );
  }

  if (state.view === "templates") {
    if (!bundle) {
      return <DataPendingNotice onRetry={onRetryLoad} slow={loadSlow} />;
    }
    return (
      <TemplatesPage bundle={bundle} onNavigate={onNavigate} state={state} />
    );
  }

  if (state.view === "patterns") {
    return (
      <PlaybooksPage
        bundle={bundle}
        onNavigate={onNavigate}
        onOpenGlossary={onOpenGlossary}
        onOpenNodeByItemId={onOpenNodeByItemId}
        state={state}
      />
    );
  }

  if (state.view === "start-here") {
    return (
      <StartHerePage bundle={bundle} onNavigate={onNavigate} state={state} />
    );
  }

  if (state.view === "about") {
    return <AboutPage />;
  }

  if (state.view === "retired") {
    if (!bundle) {
      return <DataPendingNotice onRetry={onRetryLoad} slow={loadSlow} />;
    }
    return (
      <section className="notice">
        <h1>Record not found: {state.query}</h1>
        <p>Try a different identifier or keyword.</p>
        <div className="card-actions">
          <AppLink onNavigate={onNavigate} patch={{ query: state.query }} variant="primary" view="search">
            Search records
          </AppLink>
          <AppLink onNavigate={onNavigate} variant="secondary" view="start-here">
            Start guided path
          </AppLink>
        </div>
      </section>
    );
  }

  if (!bundle) {
    return <DataPendingNotice onRetry={onRetryLoad} slow={loadSlow} />;
  }

  return (
    <ExplorePage
      bundle={bundle!}
      graphReady={graphReady}
      onNavigate={onNavigate}
      onOpenGlossary={onOpenGlossary}
      onOpenNode={onOpenNode}
      onRequestFullGraph={onRequestFullGraph}
      state={state}
    />
  );
}

function routeLoadingCopy(view: ViewState["view"]) {
  switch (view) {
    case "matrix":
      return {
        title: "Loading comparison data",
        description:
          "Loading the comparison.",
      };
    case "catalog-detail":
      return {
        title: "Loading the Library",
        description:
          "Loading the selected publication.",
      };
    case "sources":
      return {
        title: "Loading Sources",
        description:
          "Loading publication details.",
      };
    case "templates":
      return {
        title: "Loading document tasks",
        description:
          "Loading document options.",
      };
    case "atlas-map":
      return {
        title: "Loading the Atlas",
        description:
          "Loading the selected record.",
      };
    default:
      return {
        title: "Loading connection data",
        description:
          "Loading the public mapping data. This should complete in a moment.",
      };
  }
}
