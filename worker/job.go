package main

import "errors"

var supportedRecipes = map[string]bool{
	"summary":          true,
	"compare":          true,
	"rank":             true,
	"distribution":     true,
	"change_over_time": true,
}

func validateRecipe(name string) error {
	if !supportedRecipes[name] {
		return errors.New("unsupported recipe")
	}
	return nil
}
