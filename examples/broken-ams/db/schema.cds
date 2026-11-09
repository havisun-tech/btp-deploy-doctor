namespace sap.orders;

entity Orders {
  key ID     : UUID;
  customer   : String(100);
  region     : String(2);
  amount     : Decimal(10, 2);
  status     : String(20);
}
