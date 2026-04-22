import { cn } from "@/lib/utils";

interface PhoneMockupProps {
  src: string;
  alt: string;
  className?: string;
}

export const PhoneMockup = ({ src, alt, className }: PhoneMockupProps) => {
  return (
    <div
      className={cn(
        "rounded-[2.75rem] p-[5px] bg-gradient-to-b from-[#1f1f23] to-[#0a0a0c] drop-shadow-[0_40px_60px_rgba(0,0,0,0.55)]",
        className
      )}
    >
      <div className="bg-black rounded-[2.5rem] p-[3px]">
        <div className="relative overflow-hidden rounded-[2.25rem] aspect-[9/19.5] bg-black">
          <img
            src={src}
            alt={alt}
            className="absolute left-0 w-full select-none pointer-events-none"
            style={{
              top: "-13%",
              height: "124%",
              objectFit: "cover",
              objectPosition: "top center",
            }}
            draggable={false}
          />
          {/* Dynamic Island */}
          <div className="absolute top-[1%] left-1/2 -translate-x-1/2 w-[32%] h-[4.2%] rounded-full bg-black z-10" />
        </div>
      </div>
    </div>
  );
};
