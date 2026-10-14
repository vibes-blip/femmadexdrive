export const houseNumberFromInput=value=>String(value||"").trim().match(/^\s*(\d+[a-z]?(?:[-/]\d+[a-z]?)?)\s*,?(?:\s+|$)/i)?.[1]||"";

export const addressWithHouseNumber=(address,houseNumber,providerHouseNumber)=>{
 const base=String(address||"").trim();
 const number=String(houseNumber||"").trim();
 if(!number)return base;
 const verifiedNumber=String(providerHouseNumber||houseNumberFromInput(base)).trim();
 const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
 const street=verifiedNumber&&base.match(new RegExp(`^${escapeRegExp(verifiedNumber)}(?=\\s|,)`,"i"))
  ?base.replace(new RegExp(`^${escapeRegExp(verifiedNumber)}[,\\s]+`,"i"),"")
  :base;
 if(street.match(new RegExp(`^${escapeRegExp(number)}(?=\\s|,)`,"i")))return street;
 return `${number}, ${street}`;
};

export const preserveCustomerAddress=(providerAddress,customerAddress,houseNumber,providerHouseNumber)=>{
 const canonical=addressWithHouseNumber(providerAddress,houseNumber,providerHouseNumber);
 const original=String(customerAddress||"").trim();
 if(!original)return canonical;
 const normalize=value=>value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
 const normalizedOriginal=normalize(original);
 if(!normalizedOriginal||normalize(canonical).includes(normalizedOriginal))return canonical;
 return `${canonical} (${original})`;
};
