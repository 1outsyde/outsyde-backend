import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface SearchFilterProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  categories: string[];
  selectedCategories: string[];
  onCategoryToggle: (category: string) => void;
  onFilterClick?: () => void;
}

export default function SearchFilter({
  searchValue,
  onSearchChange,
  categories,
  selectedCategories,
  onCategoryToggle,
  onFilterClick,
}: SearchFilterProps) {
  return (
    <div className="space-y-4" data-testid="search-filter">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search businesses, products, services..."
            className="pl-10 h-12 rounded-full"
            data-testid="input-search-filter"
          />
          {searchValue && (
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8"
              onClick={() => onSearchChange("")}
              data-testid="button-clear-search"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <Button
          size="icon"
          variant="outline"
          className="h-12 w-12 rounded-full"
          onClick={onFilterClick}
          data-testid="button-filters"
        >
          <SlidersHorizontal className="h-5 w-5" />
        </Button>
      </div>

      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-2 pb-2">
          {categories.map((category) => {
            const isSelected = selectedCategories.includes(category);
            return (
              <Badge
                key={category}
                variant={isSelected ? "default" : "outline"}
                className="cursor-pointer px-4 py-2"
                onClick={() => onCategoryToggle(category)}
                data-testid={`filter-category-${category}`}
              >
                {category}
              </Badge>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
