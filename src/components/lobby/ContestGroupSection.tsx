import { useRef, useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ContestCard } from "@/components/ContestCard";

interface Contest {
  id: string;
  regattaName: string;
  genderCategory: "Men's" | "Women's";
  lockTime: string;
  lockTimeRaw: string;
  entryFeeCents: number;
  payoutStructure: Record<string, number> | null;
  prizePoolCents: number;
  currentEntries: number;
  maxEntries: number;
  hasOverflow: boolean;
  userEntered: boolean;
  entryTiers: any[] | null;
  bannerUrl: string | null;
  events?: string[];
}

interface Props {
  title: string;
  description?: string | null;
  contests: Contest[];
}

export const ContestGroupSection = ({ title, description, contests }: Props) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  useEffect(() => {
    checkScroll();
    const el = scrollRef.current;
    if (el) el.addEventListener("scroll", checkScroll, { passive: true });
    window.addEventListener("resize", checkScroll);
    return () => {
      el?.removeEventListener("scroll", checkScroll);
      window.removeEventListener("resize", checkScroll);
    };
  }, [contests]);

  const scroll = (dir: number) => {
    scrollRef.current?.scrollBy({ left: dir * 400, behavior: "smooth" });
  };

  if (contests.length === 0) return null;

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">{title}</h2>
          {description && <p className="text-sm text-slate-500 mt-0.5">{description}</p>}
        </div>
        {(canScrollLeft || canScrollRight) && (
          <div className="flex gap-2">
            <button
              onClick={() => scroll(-1)}
              disabled={!canScrollLeft}
              className="w-9 h-9 rounded-full bg-white shadow-md border border-slate-200 flex items-center justify-center hover:bg-slate-50 transition-colors disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => scroll(1)}
              disabled={!canScrollRight}
              className="w-9 h-9 rounded-full bg-white shadow-md border border-slate-200 flex items-center justify-center hover:bg-slate-50 transition-colors disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <div
        ref={scrollRef}
        className="flex gap-5 overflow-x-auto pb-4 snap-x snap-mandatory scrollbar-hide"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {contests.map((c, idx) => (
          <div
            key={c.id}
            className="snap-start flex-shrink-0 w-[380px] animate-fade-in h-full"
            style={{ animationDelay: `${idx * 0.05}s` }}
          >
            <ContestCard
              id={c.id}
              regattaName={c.regattaName}
              genderCategory={c.genderCategory}
              lockTime={c.lockTime}
              lockTimeRaw={c.lockTimeRaw}
              entryFeeCents={c.entryFeeCents}
              payoutStructure={c.payoutStructure}
              prizePoolCents={c.prizePoolCents}
              currentEntries={c.currentEntries}
              maxEntries={c.maxEntries}
              hasOverflow={c.hasOverflow}
              userEntered={c.userEntered}
              entryTiers={c.entryTiers}
              bannerUrl={c.bannerUrl}
              events={c.events}
            />
          </div>
        ))}
      </div>
    </section>
  );
};
