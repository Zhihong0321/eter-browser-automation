# Tables

| table | route | columns | C R U D | references |
|---|---|---|---|---|
| `quotation` | /quotation | 11 | CR-- | debtor, salesagent, currency |
| `invoice` | /invoice | 12 | CR-- | debtor, salesagent, purchaseinvoice, creditterm, currency |
| `creditnote` | /creditnote | 12 | CR-- | debtor, salesagent, invoice, currency |
| `purchaseorder` | /purchaseorder | 10 | CR-- | creditor, creditterm, currency |
| `purchaseinvoice` | /purchaseinvoice | 12 | CR-- | invoice, creditor, creditterm, currency |
| `purchasereturn` | /purchasereturn | 12 | CR-- | creditor, invoice, creditterm, currency |
| `cashbookentry` | /cashbookentry | 11 | CR-- | currency |
| `journalentry` | /journalentry | 8 | CR-- | journaltype, currency |
| `knockoffentry` | /knockoffentry | 8 | CR-- | debtor, currency |
| `bankreconciliation` | /bankreconciliation | 6 | CR-- | profitandlossstatement, trialbalance |
| `banktransactions` | /banktransactions | 7 | -R-- | - |
| `ledger` | /ledger | 9 | -R-- | journaltype, trialbalance |
| `journaloftransaction` | /journaloftransaction | 9 | -R-- | - |
| `trialbalance` | /trialbalance | 2 | -R-- | - |
| `profitandlossstatement` | /profitandlossstatement | 2 | -R-- | - |
| `balancesheetstatement` | /balancesheetstatement | 2 | -R-- | - |
| `debtoraging` | /debtoraging | 11 | -R-- | salesagent, currency, trialbalance |
| `creditoraging` | /creditoraging | 10 | -R-- | currency, trialbalance |
| `debtorstatement` | /debtorstatement | 7 | -R-- | salesagent, area, currency, trialbalance |
| `creditorstatement` | /creditorstatement | 6 | -R-- | area, currency, trialbalance |
| `report_all` | /report/all | 2 | CR-- | - |
| `audittrail` | /audittrail | 5 | -R-- | user |
| `fileattachment` | /fileattachment | 5 | -R-- | - |
| `documentscanner` | /documentscanner | 1 | CR-D | - |
| `fiscalyear` | /fiscalyear | 4 | CRU- | - |
| `openingbalance` | /openingbalance | 5 | -RU- | account |
| `stockvalue` | /stockvalue | 13 | -RU- | - |
| `user` | /user | 7 | CRU- | account |
| `banksettings_default` | /banksettings/default | 4 | CR-- | account, currency |
| `banksettings_mbb` | /banksettings/mbb | 4 | CR-- | account, currency |
| `currency` | /currency | 8 | -RU- | account |
| `numberingformat` | /numberingformat | 6 | CRU- | - |
| `account` | /account | 4 | CRUD | accounttype, trialbalance |
| `accounttype` | /accounttype | 5 | -RU- | account, report_all, user |
| `debtor` | /debtor | 7 | CR-- | currency, area, salesagent |
| `creditor` | /creditor | 6 | CR-- | currency, area |
| `journaltype` | /journaltype | 4 | CRUD | cashbookentry |
| `paymentmethod` | /paymentmethod | 9 | CRUD | journaltype |
| `area` | /area | 3 | CR-- | - |
| `creditterm` | /creditterm | 4 | CRUD | - |
| `salesagent` | /salesagent | 4 | CR-- | - |
| `product` | /product | 5 | CR-- | - |
| `productposting` | /productposting | 8 | CRU- | product, account, purchasereturn, trialbalance |