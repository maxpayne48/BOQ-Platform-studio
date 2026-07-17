import React, { useState, useEffect } from "react";
import { Sparkles, ArrowRight, ShieldCheck, Mail, AlertTriangle, CheckCircle } from "lucide-react";
import FlipspacesLogo from "./FlipspacesLogo.tsx";

interface LoginPageProps {
  onLoginSuccess: (email: string, rememberMe: boolean) => void;
}

export default function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Simple domain validation helper
  const validateEmailDomain = (val: string): boolean => {
    if (!val) return false;
    const lower = val.toLowerCase().trim();
    // Simple regex check for valid email layout
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(lower)) return false;

    return lower.endsWith("@flipspaces.com") || lower.endsWith("@flipspaces.in");
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEmail(value);
    
    // Clear any previous general error or success messages
    setSuccessMsg(null);

    if (!value) {
      setError(null);
      return;
    }

    // Only validate the domain if they entered a full email (contains '@')
    if (value.includes("@")) {
      const parts = value.split("@");
      if (parts[1] && parts[1].includes(".")) {
        const isValid = validateEmailDomain(value);
        if (!isValid) {
          setError("Only Flipspaces company email addresses are allowed.");
        } else {
          setError(null);
        }
      } else {
        setError(null);
      }
    } else {
      setError(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    const isValid = validateEmailDomain(email);
    if (!isValid) {
      setError("Only Flipspaces company email addresses are allowed.");
      return;
    }

    setError(null);
    setIsLoading(true);

    // Simulate standard rate-limiting / mock loading security check
    setTimeout(() => {
      setIsLoading(false);
      setSuccessMsg("Email verified successfully! Logging you in...");
      setTimeout(() => {
        onLoginSuccess(email.trim().toLowerCase(), rememberMe);
      }, 1000);
    }, 1200);
  };

  const isButtonEnabled = validateEmailDomain(email) && !error && !isLoading;

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-white text-[#111111] antialiased font-sans">
      
      {/* LEFT SIDE (45% Width on Desktop) */}
      <div className="hidden lg:flex lg:w-[45%] relative overflow-hidden bg-[#222222]">
        {/* Architectural Concrete Geometric Background Image */}
        <div 
          className="absolute inset-0 bg-cover bg-center opacity-65 scale-105 transition-transform duration-10000 hover:scale-100"
          style={{ 
            backgroundImage: `url('https://images.unsplash.com/photo-1600585154526-990dced4db0d?auto=format&fit=crop&w=1200&q=80')` 
          }}
        />
        
        {/* Dark warm overlay */}
        <div className="absolute inset-0 bg-[#1a1a1a]/55 mix-blend-multiply" />
        
        {/* Thick vertical yellow accent bar in the top-right */}
        <div className="absolute top-12 right-12 w-4 h-32 bg-[#FFE200] rounded-sm shadow-md" />

        {/* Floating Glassmorphic Card */}
        <div className="absolute top-1/2 left-16 -translate-y-1/2 backdrop-blur-md bg-black/20 border border-white/10 rounded-2xl p-12 max-w-sm w-[calc(100%-8rem)] flex flex-col justify-between min-h-[340px] shadow-2xl">
          <div className="space-y-3">
            <span className="text-white/80 font-light text-3xl tracking-wide block">
              Bring
            </span>
            <span className="text-white font-black text-6xl tracking-tight leading-none block">
              Spaces
            </span>
            <span className="text-white/80 font-light text-3xl tracking-wide block">
              To Life
            </span>
          </div>
          
          {/* Yellow horizontal bar at the bottom left of the glass card */}
          <div className="w-16 h-1.5 bg-[#FFE200] rounded-sm mt-12 shadow-sm" />
        </div>
      </div>

      {/* RIGHT SIDE (55% Width on Desktop) */}
      <div className="w-full lg:w-[55%] flex flex-col justify-between min-h-screen lg:min-h-0 bg-white relative">
        
        {/* Official Flipspaces Logo positioned in top right */}
        <div className="absolute top-8 right-8 md:top-12 md:right-12 select-none">
          <div className="flex items-center gap-1.5">
            <FlipspacesLogo className="w-40 md:w-48 h-auto" />
          </div>
        </div>

        {/* Center Container */}
        <div className="flex-1 flex items-center justify-center py-24 px-6 sm:px-12 lg:px-16">
          <div className="max-w-md w-full space-y-10">
            
            {/* Header Title */}
            <div className="space-y-2">
              <h1 className="text-4xl font-extrabold text-[#111111] tracking-tight">
                Signin
              </h1>
            </div>

            {/* Login Form */}
            <form onSubmit={handleSubmit} className="space-y-6">
              
              {/* Email Input block */}
              <div className="space-y-2">
                <label htmlFor="email" className="block text-sm font-medium text-[#666666] transition-colors">
                  Enter your Flipspaces ID
                </label>
                <div className="relative rounded-md shadow-3xs">
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={handleEmailChange}
                    placeholder="example.abc@flipspaces.com"
                    autoComplete="email"
                    aria-label="Flipspaces Email ID"
                    className={`block w-full px-4 py-3.5 border rounded-lg text-slate-900 placeholder-[#999999] text-sm font-medium focus:outline-none focus:ring-2 focus:ring-black/10 transition-all ${
                      error 
                        ? "border-red-500 bg-red-50/10 focus:border-red-500" 
                        : "border-[#E0E0E0] focus:border-black"
                    }`}
                  />
                </div>
                
                {/* Email Validation Error message */}
                {error && (
                  <p className="text-xs text-red-600 font-semibold flex items-center gap-1.5 mt-2 animate-fade-in" id="error-message">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    {error}
                  </p>
                )}

                {/* Success verified message */}
                {successMsg && (
                  <p className="text-xs text-emerald-600 font-semibold flex items-center gap-1.5 mt-2 animate-fade-in">
                    <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                    {successMsg}
                  </p>
                )}
              </div>

              {/* Remember Me radio/checkbox */}
              <div className="flex items-center">
                <button
                  type="button"
                  id="remember_me_btn"
                  onClick={() => setRememberMe(!rememberMe)}
                  className="flex items-center gap-2 text-sm text-[#666666] select-none hover:text-slate-800 transition-colors py-1 group"
                >
                  <span className={`w-4 h-4 rounded-full border flex items-center justify-center transition-all ${
                    rememberMe 
                      ? 'border-black bg-white ring-2 ring-black/5' 
                      : 'border-[#CCCCCC] bg-white group-hover:border-slate-400'
                  }`}>
                    {rememberMe && <span className="w-2 h-2 rounded-full bg-black"></span>}
                  </span>
                  Remember Me
                </button>
              </div>

              {/* Send OTP Primary Button */}
              <div className="space-y-3">
                <button
                  type="submit"
                  id="send_otp_btn"
                  disabled={!isButtonEnabled}
                  className={`w-full py-4 px-4 rounded-lg text-sm transition-all duration-200 shadow-3xs flex items-center justify-center gap-2 ${
                    isButtonEnabled
                      ? "bg-[#FFE200] text-black font-extrabold hover:bg-[#F3D700] hover:shadow-xs active:scale-[0.99]"
                      : "bg-[#E5E5E5] text-[#999999] cursor-not-allowed font-medium"
                  }`}
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin"></span>
                      Verifying...
                    </span>
                  ) : (
                    "Send OTP"
                  )}
                </button>
                
                {/* Secondary verification notice */}
                <p className="text-center text-xs text-[#888888] font-medium leading-normal">
                  We'll send a verification code to your email
                </p>
              </div>

            </form>
          </div>
        </div>

        {/* Footer info at bottom center */}
        <div className="text-center text-xs text-[#888888] font-medium py-8 border-t border-slate-50">
          By continuing you agree to our{" "}
          <a href="#" className="underline hover:text-slate-700 transition-colors">Terms of Service</a>
          {" "}and{" "}
          <a href="#" className="underline hover:text-slate-700 transition-colors">Privacy Policy</a>
        </div>

      </div>

    </div>
  );
}
