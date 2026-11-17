package main

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"sort"
)

type coverageRow struct {
	Year        int            `json:"year"`
	Status      string         `json:"status"`
	Rows        int            `json:"rows"`
	AmountPesos *float64       `json:"amount_pesos"`
	Scopes      map[string]any `json:"scopes"`
	Notes       []string       `json:"notes"`
}

type analysisRequest struct {
	Recipe       string  `json:"recipe"`
	Year         *int    `json:"year,omitempty"`
	Status       *string `json:"status,omitempty"`
	CompareYears []int   `json:"compare_years,omitempty"`
}

type analysisJob struct {
	analysisRequest
	Rows []coverageRow `json:"rows,omitempty"`
}

type validationReport struct {
	Status string   `json:"status"`
	Checks []string `json:"checks"`
}

type analysisResponse struct {
	Recipe          string           `json:"recipe"`
	RecipeVersion   string           `json:"recipe_version"`
	Filters         map[string]any   `json:"filters"`
	InputRows       int              `json:"input_rows"`
	OutputRows      int              `json:"output_rows"`
	Calculation     string           `json:"calculation"`
	Result          any              `json:"result,omitempty"`
	Validation      validationReport `json:"validation"`
	Warnings        []string         `json:"warnings"`
	Limitations     []string         `json:"limitations"`
	Reproducibility string           `json:"reproducibility_status"`
}

type summaryResult struct {
	YearCount      int            `json:"year_count"`
	SourceRows     int            `json:"source_rows"`
	AmountRowCount int            `json:"amount_row_count"`
	StatusCounts   map[string]int `json:"status_counts"`
}

type compareResult struct {
	YearA         int      `json:"year_a"`
	YearB         int      `json:"year_b"`
	Status        string   `json:"coverage_status"`
	ValueA        float64  `json:"value_a_pesos"`
	ValueB        float64  `json:"value_b_pesos"`
	Difference    float64  `json:"difference_pesos"`
	PercentChange *float64 `json:"percent_change"`
}

type distributionGroup struct {
	Value      string  `json:"value"`
	Count      int     `json:"count"`
	Percentage float64 `json:"percentage"`
}

type distributionResult struct {
	Field  string              `json:"field"`
	Groups []distributionGroup `json:"groups"`
}

type rankedAmount struct {
	Rank   int      `json:"rank"`
	Year   int      `json:"year"`
	Amount *float64 `json:"amount_pesos"`
	Status string   `json:"status"`
}

type trendPoint struct {
	Year          int      `json:"year"`
	Amount        *float64 `json:"amount_pesos"`
	Status        string   `json:"status"`
	Change        *float64 `json:"change_from_previous_pesos"`
	PercentChange *float64 `json:"percent_change_from_previous"`
}

func loadCoverage(path string) ([]coverageRow, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var rows []coverageRow
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errors.New("coverage release is empty")
	}
	return rows, nil
}

func loadVerifiedCoverage(path string) ([]coverageRow, error) {
	if err := verifyRelease(path, verifiedCoverageChecksum); err != nil {
		return nil, err
	}
	return loadCoverage(path)
}

func failedAnalysis(request analysisRequest, filters map[string]any, message string) (analysisResponse, error) {
	return analysisResponse{Recipe: request.Recipe, RecipeVersion: "1", Filters: filters, Validation: validationReport{Status: "Fail", Checks: []string{message}}, Warnings: []string{}, Limitations: []string{}, Reproducibility: "Failed"}, errors.New(message)
}

func runAnalysis(rows []coverageRow, request analysisRequest) (analysisResponse, error) {
	filters := map[string]any{}
	if request.Year != nil {
		filters["year"] = *request.Year
	}
	if request.Status != nil {
		filters["status"] = *request.Status
	}
	if len(request.CompareYears) > 0 {
		filters["compare_years"] = request.CompareYears
	}
	if err := validateRecipe(request.Recipe); err != nil {
		return failedAnalysis(request, filters, err.Error())
	}
	if len(rows) == 0 {
		return failedAnalysis(request, filters, "no normalized dataset rows are available")
	}
	filtered := rows
	if request.Recipe == "compare" {
		if len(request.CompareYears) != 2 || request.CompareYears[0] == request.CompareYears[1] {
			return failedAnalysis(request, filters, "compare requires two distinct fiscal years")
		}
	} else if len(request.CompareYears) > 0 {
		return failedAnalysis(request, filters, "compare_years is only valid for the compare recipe")
	}
	if request.Year != nil || request.Status != nil {
		filtered = make([]coverageRow, 0, len(rows))
		for _, row := range rows {
			if request.Year != nil && row.Year != *request.Year {
				continue
			}
			if request.Status != nil && row.Status != *request.Status {
				continue
			}
			filtered = append(filtered, row)
		}
		if len(filtered) == 0 {
			return failedAnalysis(request, filters, "filters have no matching coverage rows")
		}
	}
	warnings := []string{}
	limitations := []string{"GAA amounts are appropriations, not obligations, releases, or spending. Coverage and category scopes vary by year; results preserve the source's stated scope and should not be read as a continuous comparable national series."}
	var result any
	var calculation string
	outputRows := 1
	switch request.Recipe {
	case "summary":
		calculation = "Count selected coverage years and source rows by status; do not sum appropriations across years."
		counts := map[string]int{}
		sourceRows, amountRows := 0, 0
		for _, row := range filtered {
			sourceRows += row.Rows
			counts[row.Status]++
			if row.AmountPesos != nil {
				amountRows++
			}
		}
		result = summaryResult{len(filtered), sourceRows, amountRows, counts}
	case "compare":
		calculation = "Compare reported appropriations only when coverage status and scope match; difference = year B - year A; percent change = difference / abs(year A) * 100."
		pair := [2]*coverageRow{}
		for i := range filtered {
			if filtered[i].Year == request.CompareYears[0] {
				pair[0] = &filtered[i]
			}
			if filtered[i].Year == request.CompareYears[1] {
				pair[1] = &filtered[i]
			}
		}
		if pair[0] == nil || pair[1] == nil {
			return failedAnalysis(request, filters, "both comparison years must exist in the selected dataset and filters")
		}
		a, b := pair[0], pair[1]
		filtered = []coverageRow{*a, *b}
		if a.AmountPesos == nil || b.AmountPesos == nil {
			return failedAnalysis(request, filters, "both comparison years need reported amounts")
		}
		if a.Status != b.Status || !sameScopeKeys(a.Scopes, b.Scopes) {
			return failedAnalysis(request, filters, "comparison years have different coverage status or scopes")
		}
		difference := *b.AmountPesos - *a.AmountPesos
		var percent *float64
		if *a.AmountPesos != 0 {
			value := difference / math.Abs(*a.AmountPesos) * 100
			percent = &value
		}
		result = compareResult{a.Year, b.Year, a.Status, *a.AmountPesos, *b.AmountPesos, difference, percent}
	case "rank":
		calculation = "Sort reported appropriations descending; use fiscal year ascending as the deterministic tie-break and assign equal ranks to ties."
		out := make([]rankedAmount, 0, len(filtered))
		for _, row := range filtered {
			out = append(out, rankedAmount{Year: row.Year, Amount: row.AmountPesos, Status: row.Status})
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Amount == nil {
				if out[j].Amount == nil {
					return out[i].Year < out[j].Year
				}
				return false
			}
			if out[j].Amount == nil {
				return true
			}
			if *out[i].Amount == *out[j].Amount {
				return out[i].Year < out[j].Year
			}
			return *out[i].Amount > *out[j].Amount
		})
		for i := range out {
			if i == 0 || out[i].Amount == nil || out[i-1].Amount == nil || *out[i].Amount != *out[i-1].Amount {
				out[i].Rank = i + 1
			} else {
				out[i].Rank = out[i-1].Rank
			}
		}
		result = out
		outputRows = len(out)
	case "distribution":
		calculation = "Count coverage rows per status and divide by the selected row count to compute percentages."
		counts := map[string]int{}
		for _, row := range filtered {
			counts[row.Status]++
		}
		statuses := make([]string, 0, len(counts))
		for status := range counts {
			statuses = append(statuses, status)
		}
		sort.Strings(statuses)
		groups := make([]distributionGroup, 0, len(statuses))
		for _, status := range statuses {
			groups = append(groups, distributionGroup{status, counts[status], float64(counts[status]) * 100 / float64(len(filtered))})
		}
		result = distributionResult{"status", groups}
		outputRows = len(groups)
	case "change_over_time":
		calculation = "Compute period-over-period differences only for adjacent fiscal years with reported amounts and matching coverage status and scope."
		sort.Slice(filtered, func(i, j int) bool { return filtered[i].Year < filtered[j].Year })
		points := make([]trendPoint, 0, len(filtered))
		for i, row := range filtered {
			point := trendPoint{Year: row.Year, Amount: row.AmountPesos, Status: row.Status}
			if i > 0 {
				previous := filtered[i-1]
				if previous.Year+1 == row.Year && previous.AmountPesos != nil && row.AmountPesos != nil && previous.Status == row.Status && sameScopeKeys(previous.Scopes, row.Scopes) {
					change := *row.AmountPesos - *previous.AmountPesos
					point.Change = &change
					if *previous.AmountPesos != 0 {
						pct := change / math.Abs(*previous.AmountPesos) * 100
						point.PercentChange = &pct
					}
				}
			}
			points = append(points, point)
		}
		result = points
		outputRows = len(points)
	}
	for _, row := range filtered {
		warnings = append(warnings, row.Notes...)
	}
	checks := []string{"dataset rows loaded", "filters validated"}
	switch request.Recipe {
	case "summary":
		checks = append(checks, "coverage profile computed without summing annual amounts")
	case "compare":
		checks = append(checks, "two distinct years selected", "reported amounts and matching source scope confirmed")
	case "rank":
		checks = append(checks, "ranking sorted by amount with deterministic year tie-break")
	case "distribution":
		checks = append(checks, "category counts and denominator percentages computed")
	case "change_over_time":
		checks = append(checks, "period changes limited to adjacent matching coverage scopes")
	}
	validation := validationReport{Status: "Pass", Checks: checks}
	return analysisResponse{request.Recipe, "1", filters, len(filtered), outputRows, calculation, result, validation, unique(warnings), limitations, "Not run"}, nil
}

func sameScopeKeys(a, b map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	for key := range a {
		if _, ok := b[key]; !ok {
			return false
		}
	}
	return true
}

func unique(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}
