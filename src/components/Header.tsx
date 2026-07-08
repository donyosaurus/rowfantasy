import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Waves, LogOut, User, Menu, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";
import { cn } from "@/lib/utils";

export const Header = () => {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', user.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  const { data: isAdmin } = useQuery({
    queryKey: ['isAdmin', user?.id],
    queryFn: async () => {
      if (!user?.id) return false;
      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .maybeSingle();
      if (error) return false;
      return !!data;
    },
    enabled: !!user?.id,
  });

  const navLinks = [
    { to: "/", label: "Home" },
    { to: "/lobby", label: "Contests" },
    ...(user ? [
      { to: "/profile", label: "Profile" },
      { to: "/my-entries", label: "My Entries" },
      { to: "/my-tickets", label: "Support" },
    ] : []),
    ...(isAdmin ? [{ to: "/admin", label: "Admin" }] : []),
  ];

  const isActive = (path: string) => location.pathname === path;

  return (
    <header className="bg-primary text-primary-foreground sticky top-0 z-50 shadow-lg">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5 transition-smooth hover:opacity-90">
            <div className="bg-accent rounded-lg p-1.5">
              <Waves className="h-6 w-6 text-accent-foreground" />
            </div>
            <span className="text-xl font-heading font-extrabold tracking-tight">RowFantasy</span>
          </Link>
          
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium transition-smooth",
                  isActive(link.to)
                    ? "bg-white/15 text-white font-semibold"
                    : "text-white/70 hover:text-white hover:bg-white/10"
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            {user ? (
              <>
                <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent/20 border border-accent/30">
                  <User className="h-4 w-4 text-accent" />
                  <span className="text-sm font-semibold text-accent">@{profile?.username || 'user'}</span>
                </div>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={signOut}
                  className="text-white/70 hover:text-white hover:bg-white/10"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  <span className="hidden sm:inline">Sign Out</span>
                </Button>
              </>
            ) : (
              <>
                <Link to="/login">
                  <Button variant="ghost" size="sm" className="text-white/80 hover:text-white hover:bg-white/10">
                    Log In
                  </Button>
                </Link>
                <Link to="/signup">
                  <Button variant="hero" size="sm" className="rounded-lg">
                    Sign Up
                  </Button>
                </Link>
              </>
            )}
            <button
              className="md:hidden p-2 rounded-lg hover:bg-white/10 transition-smooth"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile nav */}
        {mobileOpen && (
          <nav className="md:hidden mt-3 pt-3 border-t border-white/10 flex flex-col gap-1 animate-fade-in">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "px-4 py-2.5 rounded-lg text-sm font-medium transition-smooth",
                  isActive(link.to)
                    ? "bg-white/15 text-white font-semibold"
                    : "text-white/70 hover:text-white hover:bg-white/10"
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
};
