package main

import "testing"

func TestValidateImport(t *testing.T) {
	cases := []struct {
		name    string
		data    []byte
		wantErr bool
	}{
		{"data.json", []byte(`[{}]`), false},
		{"data.csv", []byte("year,status\n2020,ok\n"), false},
		{"data.xlsx", []byte("PK\x03\x04content"), false},
		{"data.parquet", []byte("PAR1contentPAR1"), false},
		{"data.txt", []byte("content"), true},
		{"data.csv", []byte("not delimited"), true},
	}
	for _, test := range cases {
		if err := validateImport(test.name, test.data); (err != nil) != test.wantErr {
			t.Errorf("%s: error=%v wantErr=%v", test.name, err, test.wantErr)
		}
	}
}
