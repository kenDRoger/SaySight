package main

import "testing"

func TestValidateRecipe(t *testing.T) {
	for _, recipe := range []string{"summary", "compare", "rank", "distribution", "change_over_time"} {
		if err := validateRecipe(recipe); err != nil {
			t.Fatalf("expected %q to be supported: %v", recipe, err)
		}
	}
	if err := validateRecipe("arbitrary_sql"); err == nil {
		t.Fatal("expected arbitrary SQL to be rejected")
	}
}
