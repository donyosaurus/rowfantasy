import { useState, useMemo } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CrewLogo } from "@/components/CrewLogo";
import { Search, Plus, GraduationCap, Flag } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface LogoPickerProps {
  logoUrl: string | null;
  crewName: string;
  onSelect: (url: string | null) => void;
}

interface CollegeEntry { name: string; id: number }
interface CountryEntry { name: string; code: string }

const COLLEGES: CollegeEntry[] = [
  { name: "Harvard", id: 108 }, { name: "Yale", id: 43 }, { name: "Princeton", id: 163 },
  { name: "Brown", id: 225 }, { name: "Cornell", id: 172 }, { name: "Penn", id: 219 },
  { name: "Columbia", id: 171 }, { name: "Dartmouth", id: 159 }, { name: "Washington", id: 264 },
  { name: "California", id: 25 }, { name: "Stanford", id: 24 }, { name: "Wisconsin", id: 275 },
  { name: "Michigan", id: 130 }, { name: "Syracuse", id: 183 }, { name: "Georgetown", id: 46 },
  { name: "Navy", id: 2426 }, { name: "Northeastern", id: 111 }, { name: "Boston University", id: 104 },
  { name: "Virginia", id: 258 }, { name: "Clemson", id: 228 }, { name: "Notre Dame", id: 87 },
  { name: "Texas", id: 251 }, { name: "Ohio State", id: 194 }, { name: "Gonzaga", id: 2250 },
  { name: "Villanova", id: 222 }, { name: "Drexel", id: 2182 }, { name: "Temple", id: 218 },
  { name: "Tulsa", id: 202 }, { name: "MIT", id: 109 }, { name: "Duke", id: 150 },
  { name: "North Carolina", id: 153 }, { name: "Minnesota", id: 135 }, { name: "Indiana", id: 84 },
  { name: "Oregon State", id: 204 }, { name: "USC", id: 30 }, { name: "UCLA", id: 26 },
  { name: "Rutgers", id: 164 }, { name: "Bucknell", id: 2083 }, { name: "Colgate", id: 2142 },
  { name: "George Washington", id: 45 }, { name: "Lehigh", id: 2329 }, { name: "Holy Cross", id: 107 },
  { name: "Loyola Maryland", id: 2352 }, { name: "Marist", id: 2368 }, { name: "Mercyhurst", id: 2382 },
  { name: "Oklahoma", id: 201 }, { name: "Tennessee", id: 2633 }, { name: "Creighton", id: 156 },
  { name: "San Diego", id: 301 }, { name: "Alabama", id: 333 }, { name: "LSU", id: 99 },
  { name: "Florida", id: 57 }, { name: "Iowa", id: 2294 }, { name: "Kansas State", id: 2306 },
  { name: "Purdue", id: 2509 }, { name: "Louisville", id: 97 }, { name: "Drake", id: 2181 },
  { name: "Rhode Island", id: 227 }, { name: "Connecticut", id: 41 }, { name: "Massachusetts", id: 113 },
  { name: "New Hampshire", id: 160 }, { name: "Vermont", id: 261 },
];

const COUNTRIES: CountryEntry[] = [
  { name: "United States", code: "us" }, { name: "Great Britain", code: "gb" },
  { name: "Germany", code: "de" }, { name: "Netherlands", code: "nl" },
  { name: "Australia", code: "au" }, { name: "New Zealand", code: "nz" },
  { name: "Italy", code: "it" }, { name: "Canada", code: "ca" },
  { name: "China", code: "cn" }, { name: "Romania", code: "ro" },
  { name: "France", code: "fr" }, { name: "Denmark", code: "dk" },
  { name: "Switzerland", code: "ch" }, { name: "Ireland", code: "ie" },
  { name: "Poland", code: "pl" }, { name: "Czech Republic", code: "cz" },
  { name: "Croatia", code: "hr" }, { name: "Norway", code: "no" },
  { name: "Sweden", code: "se" }, { name: "Spain", code: "es" },
  { name: "Japan", code: "jp" }, { name: "South Korea", code: "kr" },
  { name: "India", code: "in" }, { name: "South Africa", code: "za" },
  { name: "Brazil", code: "br" }, { name: "Argentina", code: "ar" },
  { name: "Russia", code: "ru" }, { name: "Ukraine", code: "ua" },
  { name: "Greece", code: "gr" }, { name: "Portugal", code: "pt" },
  { name: "Belgium", code: "be" }, { name: "Austria", code: "at" },
  { name: "Hungary", code: "hu" }, { name: "Serbia", code: "rs" },
  { name: "Lithuania", code: "lt" }, { name: "Latvia", code: "lv" },
  { name: "Estonia", code: "ee" }, { name: "Finland", code: "fi" },
  { name: "Bulgaria", code: "bg" }, { name: "Slovenia", code: "si" },
  { name: "Slovakia", code: "sk" }, { name: "Belarus", code: "by" },
  { name: "Cuba", code: "cu" }, { name: "Mexico", code: "mx" },
  { name: "Egypt", code: "eg" }, { name: "Turkey", code: "tr" },
  { name: "Israel", code: "il" }, { name: "Singapore", code: "sg" },
  { name: "Hong Kong", code: "hk" }, { name: "Thailand", code: "th" },
];

function collegeLogoUrl(id: number) {
  return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/${id}.png&h=80&w=80`;
}

function flagUrl(code: string) {
  return `https://hatscripts.github.io/circle-flags/flags/${code}.svg`;
}

export function LogoPicker({ logoUrl, crewName, onSelect }: LogoPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [tab, setTab] = useState("colleges");

  const filteredColleges = useMemo(
    () => COLLEGES.filter(c => c.name.toLowerCase().includes(search.toLowerCase())),
    [search]
  );
  const filteredCountries = useMemo(
    () => COUNTRIES.filter(c => c.name.toLowerCase().includes(search.toLowerCase())),
    [search]
  );

  const selectAndClose = (url: string) => {
    onSelect(url);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="relative flex-shrink-0 rounded-full border-2 border-dashed border-border hover:border-accent transition-colors cursor-pointer group">
          <CrewLogo logoUrl={logoUrl} crewName={crewName} size={40} />
          {!logoUrl && (
            <div className="absolute inset-0 rounded-full flex items-center justify-center bg-muted/80 group-hover:bg-accent/10 transition-colors">
              <Plus className="h-4 w-4 text-muted-foreground group-hover:text-accent" />
            </div>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <div className="p-3 pb-0">
            <TabsList className="w-full h-9">
              <TabsTrigger value="colleges" className="flex-1 text-xs gap-1.5">
                <GraduationCap className="h-3.5 w-3.5" />Colleges
              </TabsTrigger>
              <TabsTrigger value="flags" className="flex-1 text-xs gap-1.5">
                <Flag className="h-3.5 w-3.5" />Flags
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="p-3 pb-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
          </div>

          <TabsContent value="colleges" className="m-0">
            <ScrollArea className="h-52 px-3">
              <div className="grid grid-cols-4 gap-2 pb-3">
                {filteredColleges.map((college) => {
                  const url = collegeLogoUrl(college.id);
                  return (
                    <button
                      key={college.id}
                      type="button"
                      onClick={() => selectAndClose(url)}
                      className="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-muted transition-colors cursor-pointer"
                      title={college.name}
                    >
                      <img src={url} alt={college.name} className="w-10 h-10 rounded-full object-cover bg-muted" loading="lazy" />
                      <span className="text-[10px] text-muted-foreground text-center truncate w-full">{college.name}</span>
                    </button>
                  );
                })}
                {filteredColleges.length === 0 && (
                  <p className="col-span-4 text-center text-xs text-muted-foreground py-4">No results</p>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="flags" className="m-0">
            <ScrollArea className="h-52 px-3">
              <div className="grid grid-cols-4 gap-2 pb-3">
                {filteredCountries.map((country) => {
                  const url = flagUrl(country.code);
                  return (
                    <button
                      key={country.code}
                      type="button"
                      onClick={() => selectAndClose(url)}
                      className="flex flex-col items-center gap-1 p-2 rounded-lg hover:bg-muted transition-colors cursor-pointer"
                      title={country.name}
                    >
                      <img src={url} alt={country.name} className="w-10 h-7 rounded object-cover bg-muted" loading="lazy" />
                      <span className="text-[10px] text-muted-foreground text-center truncate w-full">{country.name}</span>
                    </button>
                  );
                })}
                {filteredCountries.length === 0 && (
                  <p className="col-span-4 text-center text-xs text-muted-foreground py-4">No results</p>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Custom URL */}
          <div className="border-t p-3 space-y-2">
            <Label className="text-xs text-muted-foreground">Custom URL</Label>
            <div className="flex gap-2">
              <Input
                placeholder="https://example.com/logo.png"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-8 text-xs"
                disabled={!customUrl.trim()}
                onClick={() => { selectAndClose(customUrl.trim()); setCustomUrl(""); }}
              >
                Use
              </Button>
            </div>
            {logoUrl && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-destructive w-full"
                onClick={() => { onSelect(null); setOpen(false); }}
              >
                Remove Logo
              </Button>
            )}
          </div>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
