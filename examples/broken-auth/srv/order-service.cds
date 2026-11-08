using { sap.capire.orders as my } from '../db/schema';

service OrderService @(requires: 'authenticated-user') {

  // Sales reps see the orders of their own country only.
  entity Orders @(restrict: [
    { grant: 'READ', to: 'SalesRep', where: 'country = $user.country' },
    { grant: '*', to: 'SalesManager' }
  ]) as projection on my.Orders;
}

service AdminService @(requires: 'Admin') {
  entity Orders as projection on my.Orders;
}
