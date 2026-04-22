import { PhoneMockup } from "@/components/PhoneMockup";
import heroPhoneContests from "@/assets/hero-phone-contests.png";
import heroPhoneDraft from "@/assets/hero-phone-draft.png";

export const HeroPhoneShowcase = () => {
  return (
    <div className="relative w-full h-[560px] lg:h-[620px] hidden md:block">
      {/* Soft teal/cyan radial glow */}
      <div
        aria-hidden
        className="absolute inset-0 -z-0"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(45, 212, 191, 0.25) 0%, rgba(45, 212, 191, 0.08) 40%, transparent 70%)",
        }}
      />

      {/* Back phone - Available Contests */}
      <PhoneMockup
        src={heroPhoneContests}
        alt="RowFantasy contests lobby"
        className="absolute top-0 left-[2%] w-[55%] max-w-[280px] -rotate-[7deg] z-10"
      />

      {/* Front phone - Your Draft */}
      <PhoneMockup
        src={heroPhoneDraft}
        alt="RowFantasy draft and entry screen"
        className="absolute top-[14%] left-[38%] w-[58%] max-w-[295px] -rotate-[2deg] z-20"
      />
    </div>
  );
};
