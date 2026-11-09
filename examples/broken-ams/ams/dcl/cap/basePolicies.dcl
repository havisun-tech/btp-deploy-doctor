POLICY "Viewer" {
	ASSIGN ROLE "Viewer";
}

POLICY "SalesRep" {
	ASSIGN ROLE "SalesRep" WHERE Region IS NOT RESTRICTED;
}

POLICY "Approver" {
	ASSIGN ROLE "Aprover";
}
