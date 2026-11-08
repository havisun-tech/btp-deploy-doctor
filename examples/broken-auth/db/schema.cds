namespace sap.capire.orders;

entity Orders {
  key ID      : UUID;
  customer    : String;
  country     : String(2);
  amount      : Decimal;
}
