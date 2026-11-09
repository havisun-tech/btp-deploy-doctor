using { sap.orders as db } from '../db/schema';

service OrderService @(requires: 'authenticated-user') {

  @(restrict: [
    { grant: 'READ', to: 'Viewer' },
    { grant: ['READ', 'WRITE'], to: 'SalesRep' },
    { grant: 'approve', to: 'Approver' },
    { grant: '*', to: 'SalesManager' }
  ])
  entity Orders as projection on db.Orders actions {
    action approve();
  };
}

// Instance-based authorization: policies can restrict these attributes.
annotate OrderService.Orders with @ams.attributes: {
  Region: (region),
  Budget: (amount)
};
