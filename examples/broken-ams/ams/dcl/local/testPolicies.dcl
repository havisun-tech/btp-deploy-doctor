// Policies for local tests with mocked users.
POLICY SalesRepEU {
	USE cap.Salesrep RESTRICT Region = 'EU';
}

POLICY ViewerSmall {
	USE cap.Viewer;
	ASSIGN ROLE Viewer WHERE Regoin = 'EU';
}
