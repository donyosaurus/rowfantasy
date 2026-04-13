import React from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ScrollToTop } from "./components/ScrollToTop";
import Index from "./pages/Index";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Lobby from "./pages/Lobby";
import RegattaDetail from "./pages/RegattaDetail";
import ContestDetail from "./pages/ContestDetail";
import Profile from "./pages/Profile";
import Admin from "./pages/Admin";
import MyEntries from "./pages/MyEntries";
import Legal from "./pages/Legal";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import ResponsiblePlay from "./pages/ResponsiblePlay";
import HelpCenter from "./pages/HelpCenter";
import Contact from "./pages/Contact";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <ScrollToTop />
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/lobby" element={<Lobby />} />
            <Route path="/contests" element={<Lobby />} />
            <Route path="/regatta/:id" element={<RegattaDetail />} />
            <Route path="/contest/:id" element={<ContestDetail />} />
            <Route path="/contest/:id/:tierId" element={<ContestDetail />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/my-entries" element={<MyEntries />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/legal" element={<Legal />} />
            <Route path="/legal/terms" element={<Terms />} />
            <Route path="/legal/privacy" element={<Privacy />} />
            <Route path="/legal/responsible-play" element={<ResponsiblePlay />} />
            <Route path="/support/help-center" element={<HelpCenter />} />
            <Route path="/support/contact" element={<Contact />} />
            
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
