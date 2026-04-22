import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Header } from "@/components/Header";
import { HeroPhoneShowcase } from "@/components/HeroPhoneShowcase";
import { Footer } from "@/components/Footer";
import { StateAvailabilityMap } from "@/components/StateAvailabilityMap";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Target, TrendingUp, Shield, Clock, Trophy } from "lucide-react";
import heroRowing from "@/assets/hero-rowing.jpeg";
import { useAuth } from "@/hooks/useAuth";
const Index = () => {
  const { user } = useAuth();
  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative bg-primary text-white py-20 md:py-32 overflow-hidden">
          {/* Background Image */}
          <div
            className="absolute inset-0 bg-cover bg-center opacity-30"
            style={{
              backgroundImage: `url(${heroRowing})`,
              backgroundPosition: "center",
            }}
          />

          {/* Overlay gradient for better text readability */}
          <div className="absolute inset-0 bg-gradient-to-b from-primary/75 via-primary/65 to-primary/85" />

          {/* Background Pattern */}
          <div className="absolute inset-0 opacity-10">
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `repeating-linear-gradient(
                90deg,
                transparent,
                transparent 50px,
                rgba(255,255,255,0.03) 50px,
                rgba(255,255,255,0.03) 51px
              )`,
              }}
            />
          </div>

          <div className="container mx-auto px-4 relative z-10">
            <div className="max-w-4xl space-y-8">
              {/* Badge */}
              <div className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border-2 border-accent/30 bg-primary/50 backdrop-blur-sm">
                <Shield className="h-4 w-4 text-accent" />
                <span className="text-accent font-medium">Live Contests • Cash Prizes • Secure Transactions</span>
              </div>

              {/* Main Headline */}
              <div>
                <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-tight">Predict, Compete, Win.</h1>
                <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-tight text-accent mt-2">
                  #1 Rowing Fantasy Platform.
                </h1>
              </div>

              {/* Description */}
              <p className="text-xl md:text-2xl text-white/90 max-w-3xl leading-relaxed">
                Draft multiple crews from a single regatta. They automatically earn points based on their actual finish.
                Win fixed prizes based on skill.
              </p>

              {/* CTA Buttons */}
              <div className="flex flex-col sm:flex-row gap-4 items-start">
                {user ? (
                  <>
                    <Link to="/lobby">
                      <Button size="lg" className="text-lg px-8 py-6 bg-accent hover:bg-accent/90 text-white rounded-xl">
                        Play Now →
                      </Button>
                    </Link>
                    <Link to="/profile">
                      <Button
                        size="lg"
                        variant="outline"
                        className="text-lg px-8 py-6 border-2 border-white/30 text-white hover:bg-white/10 rounded-xl bg-transparent"
                      >
                        My Profile
                      </Button>
                    </Link>
                  </>
                ) : (
                  <>
                    <Link to="/signup">
                      <Button size="lg" className="text-lg px-8 py-6 bg-accent hover:bg-accent/90 text-white rounded-xl">
                        Get Started →
                      </Button>
                    </Link>
                    <Button
                      size="lg"
                      variant="outline"
                      className="text-lg px-8 py-6 border-2 border-white/30 text-white hover:bg-white/10 rounded-xl bg-transparent"
                      onClick={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' })}
                    >
                      How It Works
                    </Button>
                  </>
                )}
              </div>

              {/* Feature Pills */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-8">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center flex-shrink-0">
                    <Trophy className="h-6 w-6 text-accent" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg mb-1">Fixed Prizes</h3>
                    <p className="text-white/70 text-sm">Pre-posted payouts</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center flex-shrink-0">
                    <TrendingUp className="h-6 w-6 text-accent" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg mb-1">Skill-Based</h3>
                    <p className="text-white/70 text-sm">Knowledge wins</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-accent/20 flex items-center justify-center flex-shrink-0">
                    <Shield className="h-6 w-6 text-accent" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg mb-1">Secure & Fair</h3>
                    <p className="text-white/70 text-sm">KYC verified</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section id="how-it-works" className="py-20 gradient-subtle">
          <div className="container mx-auto px-4">
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-bold mb-4">How it Works</h2>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                Compete on skill and rowing knowledge. Fixed prizes make it transparent.
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 max-w-7xl mx-auto">
              <Card className="transition-smooth hover:shadow-lg">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                    <Target className="h-6 w-6 text-accent" />
                  </div>
                  <CardTitle>1. Enter a Contest</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    Choose from available contests across international and national competitions. Select the tier of
                    contest that best suits you.
                  </p>
                </CardContent>
              </Card>

              <Card className="transition-smooth hover:shadow-lg">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                    <Trophy className="h-6 w-6 text-accent" />
                  </div>
                  <CardTitle>2. Draft Your Crews</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    Draft at least 2 crews from different events and predict their margin to victory (tie-breaker).
                    Match up against other users entered in the same contest.
                  </p>
                </CardContent>
              </Card>

              <Card className="transition-smooth hover:shadow-lg">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
                    <Clock className="h-6 w-6 text-accent" />
                  </div>
                  <CardTitle>3. Automatic Scoring</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    Earn points based on your draft picks' finish placement. The user with the most points wins the
                    contest, ties are decided using most accurate margin to victory.
                  </p>
                </CardContent>
              </Card>

              <Card className="transition-smooth hover:shadow-lg">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-success/10 flex items-center justify-center mb-4">
                    <TrendingUp className="h-6 w-6 text-success" />
                  </div>
                  <CardTitle>4. Win Prizes</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    Contest winners will have pre-posted payouts automatically deposited into their account. All
                    transactions are made through secure 3rd party payment processors.
                  </p>
                </CardContent>
              </Card>
            </div>

            <div className="text-center mt-12">
              <Link to="/contests">
                <Button size="lg" variant="cta" className="text-lg px-8 py-6">
                  View Available Contests
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Marketing Hero Section */}
        <section className="relative py-20 md:py-32 pb-0 overflow-visible bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950">
          {/* Dark pattern background */}
          <div className="absolute inset-0 opacity-30">
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `repeating-linear-gradient(
                  45deg,
                  transparent,
                  transparent 10px,
                  rgba(255,255,255,0.02) 10px,
                  rgba(255,255,255,0.02) 11px
                )`,
              }}
            />
          </div>

          <div className="container mx-auto px-4 relative z-10">
            <div className="grid lg:grid-cols-2 gap-12 items-center max-w-7xl mx-auto">
              {/* Left Content */}
              <div className="space-y-8">
                <h2 className="text-5xl md:text-6xl lg:text-7xl font-bold leading-tight">
                  <span className="text-white">BRINGING </span>
                  <span className="text-white">FANTASY </span>
                  <span className="text-white">SPORTS </span>
                  <br />
                  <span className="text-white">TO </span>
                  <span className="bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent">
                    ROWING
                  </span>
                </h2>

                <p className="text-lg md:text-xl text-gray-300 max-w-xl">
                  Join cash fantasy contests for every popular regatta. Select your crews and put your knowledge to the
                  test.
                </p>

                <div className="flex flex-col sm:flex-row gap-4">
                  <Link to="/lobby">
                    <Button
                      size="lg"
                      className="text-lg px-8 py-6 bg-white text-black hover:bg-gray-100 rounded-xl font-semibold w-full sm:w-auto"
                    >
                      Play Now
                    </Button>
                  </Link>
                  <Button
                    size="lg"
                    variant="outline"
                    className="text-lg px-8 py-6 border-2 border-white/30 text-white hover:bg-white/10 rounded-xl bg-transparent w-full sm:w-auto"
                    onClick={() => document.getElementById('more-information')?.scrollIntoView({ behavior: 'smooth' })}
                  >
                    Learn More
                  </Button>
                </div>
              </div>

              {/* Right Content - Phone Mockups */}
              <div className="relative">
                <HeroPhoneShowcase />
              </div>
            </div>
          </div>
        </section>

        {/* State Availability */}
        <section className="py-20 bg-muted border-t border-border">
          <div className="container mx-auto px-4">
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-bold mb-4">State Availability</h2>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                Check if RowFantasy contests are available in your state
              </p>
            </div>
            <StateAvailabilityMap />
          </div>
        </section>

        {/* Marketing Hero Section */}
        <section className="relative py-20 md:py-32 overflow-hidden bg-gradient-to-br from-primary via-primary/95 to-primary/90"></section>

        {/* How It Works */}
        <section id="more-information" className="py-20 bg-background border-t border-border">
          <div className="container mx-auto px-4 max-w-4xl">
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-bold mb-4">More Information</h2>
              <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                Everything you need to know about how our platform works
              </p>
            </div>

            <Accordion type="single" collapsible className="space-y-4">
              <AccordionItem value="fantasy-contests" className="border rounded-2xl px-6 bg-card">
                <AccordionTrigger className="text-xl font-semibold hover:no-underline py-6">
                  Fantasy Contests
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pb-6 text-base leading-relaxed">
                  <p className="mb-4">
                    Fantasy sports contests are classified as skill-based competitions under federal law, making them
                    exempt from federal gambling regulations. This designation recognizes that success depends primarily
                    on a player's knowledge, skill, and analytical ability rather than chance.
                  </p>
                  <p className="mb-4">
                    <strong>Why Two Crews Minimum:</strong> To ensure our contests remain skill-based and legally
                    compliant, all lineups must draft at least two crews from different events. This requirement
                    reflects the legal framework for fantasy sports and emphasizes strategic decision-making over simple
                    outcome prediction.
                  </p>
                  <p>
                    <strong>State Regulations:</strong> While federally unregulated, individual states maintain their
                    own laws governing fantasy sports contests. Some states have explicitly legalized and regulated
                    fantasy sports, while others restrict or prohibit certain types of contests. Please review our State
                    Availability Map to confirm whether contests are available in your location.
                  </p>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="deposits" className="border rounded-2xl px-6 bg-card">
                <AccordionTrigger className="text-xl font-semibold hover:no-underline py-6">
                  Deposit and Withdrawals
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pb-6 text-base leading-relaxed">
                  <p className="mb-4">
                    Add funds to your wallet securely using credit cards, debit cards, or ACH bank transfers. All
                    transactions are processed through industry-leading payment providers with bank-level encryption.
                  </p>
                  <p className="mb-4">
                    <strong>Deposits:</strong> Instant credit to your account. Minimum deposit $10.
                  </p>
                  <p>
                    <strong>Withdrawals:</strong> Request anytime. Processing typically takes 3-5 business days. Minimum
                    withdrawal $20. All withdrawals are subject to identity verification.
                  </p>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="matchmaking" className="border rounded-2xl px-6 bg-card">
                <AccordionTrigger className="text-xl font-semibold hover:no-underline py-6">
                  Matchmaking
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pb-6 text-base leading-relaxed">
                  <p className="mb-4">Choose from two contest types:</p>
                  <ul className="space-y-3 mb-4">
                    <li>
                      <strong>Head-to-Head (H2H):</strong> Compete against one other player. Winner takes the fixed
                      prize. Fair matching based on entry time.
                    </li>
                    <li>
                      <strong>Small Field (Cap-N):</strong> Join contests with 3-20 players. Top performers win fixed
                      prize tiers. Contest locks when full or at race start time.
                    </li>
                  </ul>
                  <p>
                    All contests display entry fee, prize amount, and lock time upfront. No hidden fees or changing
                    payouts.
                  </p>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="rules" className="border rounded-2xl px-6 bg-card">
                <AccordionTrigger className="text-xl font-semibold hover:no-underline py-6">
                  Rules and Scoring
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pb-6 text-base leading-relaxed">
                  <p className="mb-4">
                    <strong>How to Play:</strong>
                  </p>
                  <ol className="space-y-3 mb-4 list-decimal list-inside">
                    <li>Select the crew you predict will win the race</li>
                    <li>Enter your predicted margin of victory in seconds (to hundredths)</li>
                    <li>Submit your pick before the contest locks</li>
                  </ol>
                  <p className="mb-4">
                    <strong>Scoring:</strong>
                  </p>
                  <ul className="space-y-2 mb-4">
                    <li>• You must correctly pick the winner to be eligible for prizes</li>
                    <li>• Among correct winner picks, closest margin prediction wins</li>
                    <li>• Margin calculated as time difference between 1st and 2nd place</li>
                    <li>• In case of ties, earliest entry timestamp wins</li>
                  </ul>
                  <p>
                    <strong>Voids & Refunds:</strong> If a race is canceled or results unavailable, contests
                    automatically void and entry fees are refunded to your wallet.
                  </p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <p className="text-center text-xs text-muted-foreground mt-12 italic">
              All transactions are processed through trusted 3rd party payment providers with bank-level security and
              encryption.
            </p>
          </div>
        </section>

        {/* CTA Section */}
        {!user && (
          <section className="gradient-hero text-white py-20">
            <div className="container mx-auto px-4 text-center">
              <h2 className="text-3xl md:text-4xl font-bold mb-6">Ready to Compete?</h2>
              <p className="text-xl text-primary-foreground/90 mb-8 max-w-2xl mx-auto">
                Join RowFantasy today and put your rowing knowledge to the test.
              </p>
              <Link to="/signup">
                <Button size="lg" variant="cta" className="text-lg px-8 py-6">
                  Sign Up Now
                </Button>
              </Link>
            </div>
          </section>
        )}
      </main>

      <Footer />
    </div>
  );
};
export default Index;
