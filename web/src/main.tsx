import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { EngineGate } from "./components/EngineGate";
import { Layout } from "./components/Layout";
import { Skeleton } from "./components/ui";
import { TickerProvider } from "./lib/hooks";
import { ThemeProvider } from "./lib/theme";
import { LangKeyed, LangProvider } from "./lib/i18n";
import "./styles/app.css";
import "./styles/designs.css";

const Overview = lazy(() => import("./pages/Overview"));
const Options = lazy(() => import("./pages/Options"));
const Methods = lazy(() => import("./pages/Methods"));
const methodPage = (name: "BlackScholesTab" | "TreeTab" | "MonteCarloTab" | "LsmTab" | "GreeksTab") =>
  lazy(() => import("./pages/Methods").then((m) => ({ default: m[name] })));
const BlackScholesPage = methodPage("BlackScholesTab");
const TreePage = methodPage("TreeTab");
const MonteCarloPage = methodPage("MonteCarloTab");
const LsmPage = methodPage("LsmTab");
const GreeksPage = methodPage("GreeksTab");
const Volatility = lazy(() => import("./pages/Volatility"));
const Structured = lazy(() => import("./pages/Structured"));
const Rates = lazy(() => import("./pages/Rates"));
const Sentiment = lazy(() => import("./pages/Sentiment"));
const Documentation = lazy(() => import("./pages/Documentation"));
const About = lazy(() => import("./pages/About"));
const Models = lazy(() => import("./pages/Models"));
const Exotics = lazy(() => import("./pages/Exotics"));
const exoticPage = (name: "DigitalPage" | "AsianPage" | "CliquetPage") =>
  lazy(() => import("./pages/Exotics").then((m) => ({ default: m[name] })));
const DigitalPage = exoticPage("DigitalPage");
const AsianPage = exoticPage("AsianPage");
const CliquetPage = exoticPage("CliquetPage");
const Credit = lazy(() => import("./pages/Credit"));
const CDSPage = lazy(() => import("./pages/Credit").then((m) => ({ default: m.CDSPage })));
const MertonPage = lazy(() => import("./pages/Credit").then((m) => ({ default: m.MertonPage })));
const RatesFx = lazy(() => import("./pages/RatesFx"));
const CapsPage = lazy(() => import("./pages/RatesFx").then((m) => ({ default: m.CapsPage })));
const FxPage = lazy(() => import("./pages/RatesFx").then((m) => ({ default: m.FxPage })));
const Variance = lazy(() => import("./pages/Variance"));
const ReplicationPage = lazy(() => import("./pages/Variance").then((m) => ({ default: m.ReplicationPage })));
const PremiumPage = lazy(() => import("./pages/Variance").then((m) => ({ default: m.PremiumPage })));
const Allocation = lazy(() => import("./pages/Allocation"));
const allocationPage = (name: "OptimisationPage" | "LassoPage" | "BacktestPage") =>
  lazy(() => import("./pages/Allocation").then((m) => ({ default: m[name] })));
const OptimisationPage = allocationPage("OptimisationPage");
const LassoPage = allocationPage("LassoPage");
const BacktestPage = allocationPage("BacktestPage");
const Research = lazy(() => import("./pages/Research"));
const Theory = lazy(() => import("./pages/Theory"));
const ReplicationLab = lazy(() => import("./pages/Theory").then((m) => ({ default: m.ReplicationLab })));
const HedgingLab = lazy(() => import("./pages/Theory").then((m) => ({ default: m.HedgingLab })));
const StochasticLab = lazy(() => import("./pages/Theory").then((m) => ({ default: m.StochasticLab })));
const GirsanovLab = lazy(() => import("./pages/Theory").then((m) => ({ default: m.GirsanovLab })));
const MeasuresLab = lazy(() => import("./pages/Theory").then((m) => ({ default: m.MeasuresLab })));
const VasicekLab = lazy(() => import("./pages/Theory").then((m) => ({ default: m.VasicekLab })));
const Portfolio = lazy(() => import("./pages/Portfolio"));
const PositionsPage = lazy(() => import("./pages/Portfolio").then((m) => ({ default: m.PositionsPage })));
const RiskPage = lazy(() => import("./pages/Portfolio").then((m) => ({ default: m.RiskPage })));
const modelPage = (name: "HestonPage" | "SurfacePage" | "ExoticsPage" | "PathDependentPage") =>
  lazy(() => import("./pages/Models").then((m) => ({ default: m[name] })));
const HestonPage = modelPage("HestonPage");
const SurfacePage = modelPage("SurfacePage");
const ExoticsPage = modelPage("ExoticsPage");
const PathDependentPage = modelPage("PathDependentPage");

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <LangProvider>
        <EngineGate>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <LangKeyed>
          <TickerProvider>
            <Layout>
              <Suspense fallback={<Skeleton height={400} />}>
                <Routes>
                  <Route path="/" element={<Overview />} />
                  <Route path="/options" element={<Options />} />
                  <Route path="/methods" element={<Methods />}>
                    <Route index element={<Navigate to="black-scholes" replace />} />
                    <Route path="black-scholes" element={<BlackScholesPage />} />
                    <Route path="arbre-binomial" element={<TreePage />} />
                    <Route path="monte-carlo" element={<MonteCarloPage />} />
                    <Route path="longstaff-schwartz" element={<LsmPage />} />
                    <Route path="grecques" element={<GreeksPage />} />
                  </Route>
                  <Route path="/volatility" element={<Volatility />} />
                  <Route path="/models" element={<Models />}>
                    <Route index element={<Navigate to="heston" replace />} />
                    <Route path="heston" element={<HestonPage />} />
                    <Route path="surface" element={<SurfacePage />} />
                    <Route path="exotiques" element={<ExoticsPage />} />
                    <Route path="path-dependent" element={<PathDependentPage />} />
                  </Route>
                  <Route path="/exotics" element={<Exotics />}>
                    <Route index element={<Navigate to="digitale" replace />} />
                    <Route path="digitale" element={<DigitalPage />} />
                    <Route path="asiatique" element={<AsianPage />} />
                    <Route path="cliquet" element={<CliquetPage />} />
                  </Route>
                  <Route path="/variance" element={<Variance />}>
                    <Route index element={<Navigate to="replication" replace />} />
                    <Route path="replication" element={<ReplicationPage />} />
                    <Route path="prime" element={<PremiumPage />} />
                  </Route>
                  <Route path="/structured" element={<Structured />} />
                  <Route path="/rates" element={<Rates />} />
                  <Route path="/rates-fx" element={<RatesFx />}>
                    <Route index element={<Navigate to="caps" replace />} />
                    <Route path="caps" element={<CapsPage />} />
                    <Route path="fx" element={<FxPage />} />
                  </Route>
                  <Route path="/credit" element={<Credit />}>
                    <Route index element={<Navigate to="cds" replace />} />
                    <Route path="cds" element={<CDSPage />} />
                    <Route path="merton" element={<MertonPage />} />
                  </Route>
                  <Route path="/portfolio" element={<Portfolio />}>
                    <Route index element={<Navigate to="positions" replace />} />
                    <Route path="positions" element={<PositionsPage />} />
                    <Route path="risques" element={<RiskPage />} />
                  </Route>
                  <Route path="/allocation" element={<Allocation />}>
                    <Route index element={<Navigate to="optimisation" replace />} />
                    <Route path="optimisation" element={<OptimisationPage />} />
                    <Route path="lasso" element={<LassoPage />} />
                    <Route path="backtest" element={<BacktestPage />} />
                  </Route>
                  <Route path="/theory" element={<Theory />}>
                    <Route index element={<Navigate to="replication" replace />} />
                    <Route path="replication" element={<ReplicationLab />} />
                    <Route path="couverture" element={<HedgingLab />} />
                    <Route path="calcul-stochastique" element={<StochasticLab />} />
                    <Route path="girsanov" element={<GirsanovLab />} />
                    <Route path="p-vs-q" element={<MeasuresLab />} />
                    <Route path="vasicek" element={<VasicekLab />} />
                  </Route>
                  <Route path="/research/vol-managed" element={<Research />} />
                  <Route path="/research" element={<Navigate to="/research/vol-managed" replace />} />
                  <Route path="/sentiment" element={<Sentiment />} />
                  <Route path="/documentation" element={<Documentation />} />
                  <Route path="/about" element={<About />} />
                  <Route path="*" element={<Overview />} />
                </Routes>
              </Suspense>
            </Layout>
          </TickerProvider>
          </LangKeyed>
        </BrowserRouter>
        </EngineGate>
        </LangProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
