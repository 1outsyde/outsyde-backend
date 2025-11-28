import { useState } from "react";
import SearchFilter from "../SearchFilter";

export default function SearchFilterExample() {
  const [searchValue, setSearchValue] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);

  const categories = [
    "All",
    "Food & Drinks",
    "Beauty",
    "Health",
    "Shopping",
    "Services",
    "Entertainment",
  ];

  const handleCategoryToggle = (category: string) => {
    if (selectedCategories.includes(category)) {
      setSelectedCategories(selectedCategories.filter((c) => c !== category));
    } else {
      setSelectedCategories([...selectedCategories, category]);
    }
  };

  return (
    <div className="max-w-xl">
      <SearchFilter
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        categories={categories}
        selectedCategories={selectedCategories}
        onCategoryToggle={handleCategoryToggle}
        onFilterClick={() => console.log("Open filters")}
      />
    </div>
  );
}
