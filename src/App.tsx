import React, { useState, useEffect } from "react";
import { 
  Building2, 
  Layers, 
  Database, 
  Briefcase, 
  LineChart,
  Settings as SettingsIcon,
  Shield,
  LogOut,
  Menu,
  X,
  Sparkles
} from "lucide-react";
import DashboardTab from "./components/DashboardTab.tsx";
import HistoricalBOQsTab from "./components/HistoricalBOQsTab.tsx";
import KnowledgeBaseTab from "./components/KnowledgeBaseTab.tsx";
import UploadRFQTab from "./components/UploadRFQTab.tsx";
import RecommendationsTab from "./components/RecommendationsTab.tsx";
import AnalyticsTab from "./components/AnalyticsTab.tsx";
import SettingsTab from "./components/SettingsTab.tsx";
import AdminConsoleTab from "./components/AdminConsoleTab.tsx";
import LoginPage from "./components/LoginPage.tsx";
import FlipspacesLogo from "./components/FlipspacesLogo.tsx";


function deriveNameFromEmail(email: string): string {
  const localPart = email.split("@")[0];
  return localPart
    .replace(/[._]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return localStorage.getItem("is_authenticated") === "true";
  });
  const [userEmail, setUserEmail] = useState<string | null>(() => {
    return localStorage.getItem("user_email");
  });

  const handleLoginSuccess = (email: string, rememberMe: boolean) => {
    setIsAuthenticated(true);
    setUserEmail(email);
    if (rememberMe) {
      localStorage.setItem("is_authenticated", "true");
      localStorage.setItem("user_email", email);
    } else {
      sessionStorage.setItem("is_authenticated", "true");
      sessionStorage.setItem("user_email", email);
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setUserEmail(null);
    localStorage.removeItem("is_authenticated");
    localStorage.removeItem("user_email");
    sessionStorage.removeItem("is_authenticated");
    sessionStorage.removeItem("user_email");
  };

  // Check sessionStorage on mount
  useEffect(() => {
    const sessionAuth = sessionStorage.getItem("is_authenticated") === "true";
    const sessionEmail = sessionStorage.getItem("user_email");
    if (sessionAuth && sessionEmail) {
      setIsAuthenticated(true);
      setUserEmail(sessionEmail);
    }
  }, []);

  const [activeTab, setActiveTab] = useState<string>("dashboard");
  const [metricsRefreshTrigger, setMetricsRefreshTrigger] = useState<number>(0);
  const [loadTrigger, setLoadTrigger] = useState<number>(0);

  // Active RFQ reviewer parameters
  const [activeRfqId, setActiveRfqId] = useState<string | null>(null);
  const [activeRfqFileName, setActiveRfqFileName] = useState<string>("");
  const [activeRfqFileBuffer, setActiveRfqFileBuffer] = useState<ArrayBuffer | null>(null);

  const handleNavigateToRecommendations = (rfqId: string, fileBuffer: ArrayBuffer | null, fileName: string) => {
    setActiveRfqId(rfqId);
    setActiveRfqFileBuffer(fileBuffer);
    setActiveRfqFileName(fileName);
    setActiveTab("recommendations");
  };

  const handleRefreshMetrics = () => {
    setMetricsRefreshTrigger(prev => prev + 1);
  };

  const handleRefreshLoadTrigger = () => {
    setLoadTrigger(prev => prev + 1);
  };

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Building2 },
    { id: "historical", label: "Historical BOQs", icon: Layers },
    { id: "kb", label: "Knowledge Base", icon: Database },
    { id: "rfq", label: "Upload RFQ", icon: Briefcase },
    { id: "analytics", label: "Analytics", icon: LineChart },
    { id: "admin", label: "Admin Console", icon: Shield },
    { id: "settings", label: "Settings", icon: SettingsIcon }
  ];

  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-[#F3F5F9] flex flex-col lg:flex-row text-slate-700 antialiased font-sans">
      
      {/* MOBILE HEADER (lg:hidden) */}
      <header className="lg:hidden h-16 bg-white border-b border-slate-100 px-4 flex items-center justify-between sticky top-0 z-40 shadow-3xs">
        <div className="flex items-center gap-2" onClick={() => { setActiveTab("dashboard"); setIsMobileSidebarOpen(false); }}>
          <FlipspacesLogo className="w-36 h-auto" />
        </div>

        <button 
          onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
          className="p-2 text-slate-500 hover:text-slate-800 focus:outline-none"
          aria-label="Toggle Navigation Sidebar"
        >
          {isMobileSidebarOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </header>

      {/* LEFT SIDEBAR (Desktop persistent / Mobile drawer) */}
      <aside className={`
        fixed inset-y-0 left-0 w-64 xl:w-72 bg-white flex flex-col border-r border-slate-100/80 z-50 py-6 px-5 transition-transform duration-300 lg:translate-x-0 lg:static lg:h-screen lg:sticky lg:top-0
        ${isMobileSidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full lg:translate-x-0"}
      `}>
        {/* Mobile Close Button */}
        <button 
          onClick={() => setIsMobileSidebarOpen(false)}
          className="lg:hidden absolute top-4 right-4 p-1 text-slate-400 hover:text-slate-600"
          aria-label="Close Sidebar"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Logo and branding */}
        <div className="mb-8 flex flex-col items-start gap-1 cursor-pointer" onClick={() => { setActiveTab("dashboard"); setIsMobileSidebarOpen(false); }}>
          <div className="flex items-center gap-1">
            <FlipspacesLogo className="w-44 xl:w-48 h-auto" />
          </div>
          <div className="px-1.5 flex items-center gap-1.5 mt-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-[10px] text-slate-400 uppercase font-black tracking-widest">BOQ Intelligence Engine</span>
          </div>
        </div>

        {/* Nav Items */}
        <nav className="space-y-1.5 flex-1 overflow-y-auto pr-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id || (item.id === "rfq" && activeTab === "recommendations");
            return (
              <button
                id={`nav_tab_${item.id}`}
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setIsMobileSidebarOpen(false);
                  if (item.id !== "rfq") {
                    setActiveRfqId(null);
                  }
                }}
                className={`w-full px-4 py-3 rounded-xl text-xs font-bold transition-all flex items-center gap-3 group relative ${
                  isActive
                    ? "bg-[#FFE200] text-black shadow-3xs"
                    : "text-slate-500 hover:text-slate-800 hover:bg-[#F3F5F9]"
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 transition-transform duration-200 group-hover:scale-110 ${isActive ? "text-black" : "text-slate-400 group-hover:text-slate-700"}`} />
                <span>{item.label}</span>
                {isActive && (
                  <span className="absolute right-3 w-1.5 h-1.5 rounded-full bg-black"></span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Sidebar Assistance Card */}
        <div className="mt-auto bg-indigo-50/50 border border-indigo-100/50 rounded-2xl p-4 flex flex-col gap-2.5 shadow-3xs">
          <div className="flex items-center gap-2">
            <span className="p-1.5 bg-[#FFE200] text-black rounded-lg shadow-3xs inline-flex items-center justify-center shrink-0">
              <Sparkles className="w-3.5 h-3.5" />
            </span>
            <span className="text-[11px] font-black text-indigo-900 uppercase tracking-wider">Automated Assistant</span>
          </div>
          
          <div className="space-y-1">
            <h4 className="text-xs font-bold text-slate-800">Need immediate help?</h4>
            <p className="text-[10px] text-slate-500 leading-normal">
              Deploy our intelligent spec mapping agents directly onto your contract RFQs to auto-replay accurate rates.
            </p>
          </div>

          <button
            onClick={() => {
              setActiveTab("rfq");
              setIsMobileSidebarOpen(false);
            }}
            className="w-full mt-1.5 py-2 px-3 bg-slate-900 text-white rounded-lg text-[10px] font-extrabold hover:bg-slate-800 transition-all text-center tracking-wide uppercase active:scale-[0.98]"
          >
            Launch Active Workspace
          </button>
        </div>
      </aside>

      {/* MOBILE BACKDROP Overlay */}
      {isMobileSidebarOpen && (
        <div 
          onClick={() => setIsMobileSidebarOpen(false)}
          className="lg:hidden fixed inset-0 bg-black/40 z-45"
        />
      )}

      {/* RIGHT WORKSPACE PANELS */}
      <div className="flex-1 flex flex-col lg:h-screen min-w-0">
        
        {/* Right Header Bar */}
        <header className="h-20 bg-white border-b border-slate-100 flex items-center justify-between px-6 sm:px-8 z-30 shadow-3xs shrink-0">
          
          {/* Active Tab Header details */}
          <div className="space-y-0.5">
            <h1 className="text-xl font-extrabold font-display text-slate-800 tracking-tight leading-none uppercase">
              {activeTab === "dashboard" && "Dashboard"}
              {activeTab === "historical" && "Historical BOQs"}
              {activeTab === "kb" && "Knowledge Base"}
              {activeTab === "rfq" && "Upload RFQ"}
              {activeTab === "recommendations" && "Rate Recommendations"}
              {activeTab === "analytics" && "Estimation Analytics"}
              {activeTab === "admin" && "Admin Console"}
              {activeTab === "settings" && "Settings"}
            </h1>
            <span className="text-[10px] text-slate-400 font-bold tracking-wider block">
              {activeTab === "dashboard" && "Analytical Commercial Control & KPIs"}
              {activeTab === "historical" && "Specification Catalogs & Verified Rates"}
              {activeTab === "kb" && "Semantically Clustered Master Specs"}
              {activeTab === "rfq" && "High-Fidelity Estimator & Rate Replay"}
              {activeTab === "recommendations" && "Specification Matches & Commercial Rates"}
              {activeTab === "analytics" && "Platform Estimation Efficiency & Yield"}
              {activeTab === "admin" && "System Audits, Database Status, & Backups"}
              {activeTab === "settings" && "Confidence Thresholds, Prompt Configurations, & Models"}
            </span>
          </div>

          {/* Top Actions block */}
          <div className="flex items-center justify-end gap-4">

            {/* User Profile avatar */}
            {userEmail && (
              <div className="flex items-center gap-2.5 relative select-none">
                <div className="flex flex-col text-right hidden sm:block">
                  <span className="text-xs font-black text-slate-800 leading-tight block">{deriveNameFromEmail(userEmail)}</span>
                  <span className="text-[9px] font-bold text-slate-400 truncate max-w-[120px] block" title={userEmail}>
                    {userEmail}
                  </span>
                </div>

                {/* Initial circle */}
                <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-400 text-slate-900 flex items-center justify-center font-extrabold text-sm shadow-3xs relative">
                  {getInitials(deriveNameFromEmail(userEmail))}
                  <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white"></span>
                </div>

                {/* Direct signout */}
                <button
                  onClick={handleLogout}
                  className="p-2 text-slate-400 hover:text-red-500 transition-colors focus:outline-none"
                  title="Sign out of your session"
                  aria-label="Sign out of system"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}

          </div>

        </header>

        {/* Inner floating view wrapper */}
        <main className="flex-grow p-5 sm:p-8 overflow-y-auto">
          <div className="bg-white border border-slate-100/60 rounded-[24px] p-6 sm:p-8 shadow-xs min-h-[calc(100vh-12rem)] relative animate-fade-in">
            {activeTab === "dashboard" && (
              <DashboardTab 
                onNavigate={setActiveTab} 
                metricsRefreshTrigger={metricsRefreshTrigger} 
              />
            )}
            {activeTab === "historical" && (
              <HistoricalBOQsTab 
                onRefreshMetrics={handleRefreshMetrics} 
                loadTrigger={loadTrigger}
                onRefreshLoadTrigger={handleRefreshLoadTrigger}
              />
            )}
            {activeTab === "kb" && (
              <KnowledgeBaseTab 
                loadTrigger={loadTrigger}
              />
            )}
            {activeTab === "rfq" && (
              <UploadRFQTab 
                onNavigateToRecommendations={handleNavigateToRecommendations}
                loadTrigger={loadTrigger}
                onRefreshLoadTrigger={handleRefreshLoadTrigger}
              />
            )}
            {activeTab === "recommendations" && activeRfqId && (
              <RecommendationsTab 
                rfqId={activeRfqId}
                rfqFileName={activeRfqFileName}
                originalFileBuffer={activeRfqFileBuffer}
                onNavigateBack={() => setActiveTab("rfq")}
                onRefreshMetrics={handleRefreshMetrics}
              />
            )}
            {activeTab === "analytics" && (
              <AnalyticsTab 
                loadTrigger={loadTrigger}
              />
            )}
            {activeTab === "admin" && (
              <AdminConsoleTab />
            )}
            {activeTab === "settings" && (
              <SettingsTab 
                onRefreshSettings={handleRefreshLoadTrigger}
              />
            )}
          </div>
        </main>

        {/* Footer */}
        <footer className="bg-white border-t border-slate-100/50 py-4 px-6 text-center text-[10px] text-slate-400 font-bold uppercase tracking-wider shrink-0">
          © 2026 Flipspaces Technology Platform • Engineering Specification Clustered Mapping System.
        </footer>

      </div>

    </div>
  );
}
