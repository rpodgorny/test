//'use strict'

const INTERVAL_TO_HIDE_MESSAGE = 3000  // in ms

// Maps table names to strings to be shown in UX, namely in User -> Locked tables feature
const TABLE_NAME_MAPPING = {
    Recipe: "Recipes",
    Material: "Materials",
    TransportType: 'transport_types',
    Driver: 'Drivers',
    Car: 'Cars',
    Pump: 'Pumps',
    ConstructionSite: 'Sites',
    Customer: 'Customers',
    Contract: 'Contracts',
}

// FIXME: all non-class names should be camelCase (not CamelCase)
// FIXME: reformat this entire file to either use two or four spaces as indentation (not a mix of both)

// FIXME: in all uses of m(), stricly use a list when there's more children - do not use the variadic version of the function
// good: m(".some-class", {some: attr}, [child1, child2])
// bad: m(".some-class", {some: attr}, child1, child2)
// note this may sometimes lead up to usage of spread operator (...something) and that's ok

// FIXME: wrap this in component
let GlobalConfig = {"setup": {}, "_menu": []}

const urlParams = new URLSearchParams(window.location.search)

const anyToStr = v => {
    if (v === undefined) {
        return "___UNDEFINED___"
    }
    if (v === null) {
        return "___NULL___"
    }
    if (v === true) {
        return "___TRUE___"
    }
    if (v === false) {
        return "___FALSE__"
    }
    if (typeof(v) === "number") {
        const v2 = String(v)
        if (v2.includes(".")) {
            return "___FLOAT___" + v2
        }
        return "___INT___" + v2
    }
    return v
}

const strToAny = v => {
    if (v === "___UNDEFINED___") {
        return undefined
    }
    if (v === "___NULL___") {
        return null
    }
    if (v === "___TRUE___") {
        return true
    }
    if (v === "___FALSE___") {
        return false
    }
    if (v.startsWith("___FLOAT___")) {
        return parseFloat(v.replace("___FLOAT___", ""))
    }
    if (v.startsWith("___INT___")) {
        return parseInt(v.replace("___INT___", ""))
    }
    return v
}

// Singleton: Model holding list of locked tables for current user
let userLocks = {
    canEditUsers: null,
    tables: null,

    setData: data => {
        console.debug("userLocks.setData", data)
        userLocks.canEditUsers = data.can_edit_users
        userLocks.tables = data.user_locks.map(x => x.table_name)
    },

    isLocked: tableName => {
        return userLocks.tables ? userLocks.tables.includes(tableName) : false
    },
}

// Singleton: Model holding all transport-related values for order being edited
let modelTransport = {
    zone: null,
    zonesLoaded: false,
    distanceDrivenModified: null,
    pricePerKmModified: null,

    reset: () => {
        modelTransport.distance = null
        modelTransport.distanceDrivenModified = null
        modelTransport.pricePerKmModified = null
        modelTransport.transportZones = null
        modelTransport.zonesLoaded = false
        modelTransport.zone = null  // record
        modelTransport.preferred_zone = null  // zone ID, contains 'previous' value from DB, for Edit Order feature purposes
        modelTransport.preferred_pricePerKm = null // previous value from DB, for Edit Order feature purposes
        modelTransport.reloadVehicle(null)
        modelTransport.vehicle_identification_number = null  // Used when module_cars is off
    },

    zonesAsOptions: () => { // returns transport zones formatted in neat structure for SelectBox
        let ret = {}
        if (modelTransport.transportZones) {
            for (const x of modelTransport.transportZones) {
                ret[x.id] = x.distance_km_min + " - " + x.distance_km_max + " km, " + with_currency(x.price_per_m3) + (x.price_is_per_m3 ? " / m³" : "") + " " + (x._transport_type_name ? ("(" + x._transport_type_name + ")") : "")
            }
        }
        return ret
    },

    set_transport_zone: id => {
        modelTransport.zone = null
        if (modelTransport.transportZones) {
            for (const x of modelTransport.transportZones) {
                if (x.id == id) {
                    modelTransport.zone = x
                    // TODO: maybe a break here?
                }
            }
        }
    },

    get_distance: () => {  // Returns "valid" distance used for order: modified or default
        return modelTransport.distanceDrivenModified ? modelTransport.distanceDrivenModified : modelTransport.distance
    },

    reload_zones: () => {
        modelTransport.zone = null
        modelTransport.zonesLoaded = false
        if (GlobalConfig.setup.transport_zones) {
            const vehicleId = modelTransport.vehicle ? modelTransport.vehicle.id : ""
            m.request({ url: 'get_transport_zones?distance=' + modelTransport.get_distance() + "&vehicle=" + vehicleId}).then(data => {
                if(!data.error) {
                    modelTransport.transportZones = data
                    modelTransport.zonesLoaded = true
                }

                // Feature "select best transport zone automatically":
                if(modelTransport.vehicle && modelTransport.vehicle.charge_transport_automatically && modelTransport.transportZones.length>0) {
                    modelTransport.preferred_zone = modelTransport.transportZones[0].id
                } else {
                    modelTransport.preferred_zone = null
                }

                modelTransport.set_transport_zone(modelTransport.preferred_zone)  // if not set, user selects transport zone explicitly, due to workflow
            })
        }
    },

    change_distance: (new_distance) => {
        modelTransport.distance = new_distance
        modelTransport.distanceDrivenModified = null
        modelTransport.reload_zones()
    },

    reloadVehicle: (vehicleId) => {
        modelTransport.vehicle_id = vehicleId
        if (vehicleId) {
            m.request({url: "detail/Car/"+ vehicleId}).then(data => {
                modelTransport.vehicle = data
                modelTransport.reload_zones()
            })
        } else {
            modelTransport.vehicle = null
            modelTransport.reload_zones()
        }
    },
}

// TODO REF: move all the calculations to backend. QUE: Conflict's with another style request: "minimize queries to backend"
// Singleton: Model holding some values for order being edited
let modelOrder = {
    recipe_id: null,
    surcharges: [{}],  // Surcharges entered by user

    reset: () => {
        modelOrder.set_recipe_id(null)
        modelOrder.customer_id = null
        modelOrder.customer_name = null // used when module_contracts is off
        modelOrder.construction_site_id = null
        modelOrder.construction_site_name = null // used when module_contracts is off
        modelOrder.contract_id = null
        modelOrder.concrete_price = null  // per m3, loaded from backend
        modelOrder.volume = null
        modelOrder.surcharges = [{}]  // list of surcharges
        modelOrder.priceConcreteModified = null  // prices modified by user, e.g. discounts
        modelOrder.priceShippingModified = null
        modelOrder.priceSurchargesModified = null
        modelOrder.without_water = false
        modelOrder.comment = ""
        modelOrder.payment_type = null
    },

    set_recipe_id: (id) => {
        modelOrder.recipe_id = id
        if(modelOrder.recipe_id) {
            m.request({url: "detail/Recipe/"+ modelOrder.recipe_id}).then(data => { modelOrder.recipe_data = data })
        } else {
            modelOrder.recipe_data = {}
        }
    },

    reloadConcretePrice: () => {
        // Concrete price is counted on server side, based on discounts, so find it out:
        modelOrder.concrete_price = null
        const url = "concrete_price?recipe_id=" + modelOrder.recipe_id + "&customer_id=" + (modelOrder.customer_id || "") + "&construction_site_id=" + (modelOrder.construction_site_id || "")  // FIXME: don't build url like this
        m.request({url: url}).then(data => { modelOrder.concrete_price = data.price })
    },

    isSpecialPrice: () => {  // Returns true, if price per given customer is different from default concrete price
        return modelOrder.recipe_data && (modelOrder.recipe_data.price != modelOrder.concrete_price)
    },

    addEmptySurcharge: () => {  // Add empty surcharge if there are no empty slots
        const emptySurcharges = modelOrder.surcharges.filter(x => !x.name)
        if (!emptySurcharges.length) {
            modelOrder.surcharges.push({})
        }
    },

    deleteSurchargeByName: name => {
        let index = null
        for (let i = 0; i < modelOrder.surcharges.length; i++) {
            if (modelOrder.surcharges[i].name == name) {
                index = i
            }
        }
        modelOrder.surcharges.splice(index, 1)
    },

    getPriceConcrete: () => {  // total, unmodified concrete price for order
        return (modelOrder.concrete_price && modelOrder.volume) ? (modelOrder.concrete_price * modelOrder.volume) : null
    },

    getPriceShipping: () => {  // total, unmodified price of shipping
        // Shipping price based on transport zone
        const volumeForShippingZone = (modelTransport.zone && modelTransport.zone.price_is_per_m3) ? Math.max(modelOrder.volume, modelTransport.zone.minimal_volume) : 1
        const priceShippingZone = modelTransport.zone ? (volumeForShippingZone * modelTransport.zone.price_per_m3) : null

        // Shipping price based on car price per km
        const myDistance = modelTransport.get_distance()
        const myPrice = modelTransport.pricePerKmModified ? modelTransport.pricePerKmModified : (modelTransport.vehicle ? modelTransport.vehicle.price_per_km : null)
        const priceShippingVehicle = (myDistance && modelTransport.vehicle) ? (myDistance * myPrice) : null
        return GlobalConfig.setup.transport_zones ? priceShippingZone : priceShippingVehicle
    },

    getPriceSurcharges: () => {
        // TODO REF duplicate code with model.OrderSurcharge.price_total
        let ret = 0
        for(const surcharge of modelOrder.surcharges) {
            if(surcharge.price_type == 0) { // fixed
                ret += surcharge.price
            } else if (surcharge.price_type == 1) { // per m3
                ret += surcharge.price * modelOrder.volume
            } else if (surcharge.price_type == 2) { // per other unit
                ret += surcharge.price * surcharge.amount
            }
        }
        return ret
    },

    getPriceTotal: () => {  // Unmodified total price of order - this is what customer should pay
        return modelOrder.getPriceShipping() + modelOrder.getPriceConcrete() + modelOrder.getPriceSurcharges()
    },

    getPriceTotalModified: () => {  // Modified total price of order - this is what customer will pay
        return ((modelOrder.priceConcreteModified != null) ? modelOrder.priceConcreteModified : modelOrder.getPriceConcrete())
          + ((modelOrder.priceShippingModified != null) ? modelOrder.priceShippingModified : modelOrder.getPriceShipping())
          + ((modelOrder.priceSurchargesModified != null) ? modelOrder.priceSurchargesModified : modelOrder.getPriceSurcharges())
    },
}

// TODO: isn't there a builtin for this?
const keyFilter = (d, filter_fun) => {
    return Object.keys(d)
    .filter(filter_fun)
    .reduce((ret, k) => {
        return Object.assign(ret, {
          [k]: d[k]
        });
  }, {});
}

// Returns value rounded according to precision in GlobalConfig
const rounded = value => {
    return (value === null) ? value : value.toFixed(GlobalConfig.setup.rounding_precision)
}

// Test if value is integer. Copypasted from https://stackoverflow.com/questions/14636536
const isInteger = value => {
    return !isNaN(value) && (parseInt(Number(value)) == value) && (!isNaN(parseInt(value, 10)));
}

// Returns value with VAT
const with_vat = value => {
    return value * (1 + (GlobalConfig.setup_user.vat_rate / 100))
}

// Returns date in YYYY-MM-DD format
const std_date_format = inputDate => {
    return inputDate.toISOString().split('T')[0]
}

// Returns time in HH:MM:SS format for current timezone
const std_time_format = inputDate => {
    return inputDate.toTimeString().split(' ')[0]
}

const my_normalize = x => {
    return String(x).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const global_currency_symbol = () => {
    return (GlobalConfig.setup_user && GlobalConfig.setup_user.currency_symbol ) ? GlobalConfig.setup_user.currency_symbol : ""
}

// Distance is calculated 2* or 1*, according to the Setup
const distance_factor = () => {
    return (GlobalConfig.setup_user && GlobalConfig.setup_user.count_distance_doubled) ? 2 : 1
}

// Returns price with currency symbol. If price is NaN, shows it as a "?" symbol
const with_currency = value => {
    return (isNaN(value) ? "?" : value) + " " + global_currency_symbol()
}

// Converts hashtable { <id>: <caption_id>, ... } into structure usable as SimpleSelectBox values
const hashtable_to_selectbox = (fmt, hashtable) => {
    let ret = {}
    if(hashtable) {
        for (const [key, value] of Object.entries(hashtable)) {
            ret[key] = fmt("{" + value + "}")
        }
    }
    return ret
}

/* Transforms data returned by select/Driver endpoint to struct used by SmartSelectBox */
const driversToSmartSelectBox = data => {
    let ret = {}
    for (const x of data.data) {
        ret[x.id] = x.name + (x.contact ?(' (' + x.contact + ')') : "")
    }
    return ret
}

const transportTypesToSimpleSelectBox = data => {
    let ret = {}
    for (const x of data.data) {
        ret[x.id] = x.name  // assuming that id is always > 0, otherwise clashes with 1st option
    }
    return ret
}

/* Convert hashtable of form fields to array of fields to be shown in form.
   Fields with "title" attribute are displayed as row title: field, other fields are left unchanged
*/
// FIXME: a dictionary has no order, so the order of elements in output list is random. if it is not random in reality, that's just relying on underlying implementation and therefore a bug.
const formFieldsToLayout = fields => {
    let ret = []
    for (const field of Object.values(fields)) {
        if (field) {  // TODO: why this test? can there be nulls or something?
            if (field.attrs.title) {
                ret.push(m(InputFormRow, { field }))
            } else {
                ret.push(field)
            }
        }
    }
    return ret
}

/* Returns listview of orders with all action buttons. It is here (instead of in component definition) because of it is shared within Orders and Expeditions
*/
const listOfOrders = (vnode, select_endpoint, duplicate_button) => {
    const fmt = vnode.attrs.fmt

    const actionEdit = {
        icon: 'fas.fa-edit.pointer',
        name: fmt('{Edit record}'),
        url: '/order_edit/:id',
    }
    const actionDetail = {
        icon: 'fas.fa-info-circle.pointer',
        name: fmt('{Order detail}'),
        url: '/order_open/:id',
    }
    const actionSheet = {
        icon: 'fas.fa-file-alt.text-success',
        name: fmt('{Sheet}'),
        href: '/print/delivery_sheet/:id?lang=' + vnode.attrs.lang,
    }
    const actionInvoice = {
        icon: 'fas.fa-file-invoice-dollar.text-success',
        name: fmt('{invoice_printout}'),
        href: '/print/invoice/:id?lang=' + vnode.attrs.lang,
    }
    const actionProtocol = {
        icon: 'fas.fa-file-powerpoint.text-success',
        name: fmt('{Batch protocol}'),
        href: '/print/batch_protocol/:id?lang=' + vnode.attrs.lang,
    }
    const actionDuplicate = duplicate_button
        ? {
            icon: 'fas.fa-copy.pointer',
            name: fmt('{Duplicate}'),
            callback: Expeditions.duplicate_order,
        }
        : null
    const actionCancel = {
        icon: 'fas.fa-window-close.text-danger',
        name: fmt('{Cancel}'),
        constraint: record => record.status == 0,
        callback: (vnode, record) => {
            if (window.confirm(vnode.attrs.fmt('{Cancel this order?}')) === true) {
                MyPostRequest("cancel_order/" + record.id, {}, "/orders")
                // TODO NTH reload data
            }
        }
    }

    const actions = GlobalConfig.setup.module_delivery_sheets
        ? [ actionEdit, actionDuplicate, actionDetail, actionSheet, actionInvoice, actionProtocol, actionCancel ]
        : [ actionDetail, actionCancel ]

    const display_columns = GlobalConfig.setup.module_contracts
        ? ['auto_number', 't_human', 'r_name', 'volume_formatted', 'customer', 'vehicle_id', 'construction_site', 'comment', "payment_type_str", 'status_name']
        : ['auto_number', 't_human', 'r_name', 'volume_formatted', 'customer', 'vehicle_id', 'construction_site', 'comment', 'status_name']

    return m(ListView, {
      fmt,
      select_endpoint,
      model_name: "Order",
      order_by: "!t",
      delete_disabled: true,
      data_transform_callback: (data, fmt) => {
            return data.map(record => {
                // Show neat colors and icons for different order statuses
                let statusIcon = null
                let statusColor = null
                if (record.status == 0) { // sent to production
                    statusIcon = m("i.fas.fa-hourglass-start.mr-1")
                    statusColor = "text-primary"
                } else if (record.status == 1) { // production
                    statusIcon = m("i.fas.fa-cogs.mr-1")
                    statusColor = "text-danger"
                } else if (record.status == 2) { // finished
                    statusIcon = m("i.fas.fa-thumbs-up.mr-1")
                    statusColor = "text-success"
                } else if (record.status == 3 || record.status == 4 || record.status == 5) { // aborted by dispatcher, manager or in production
                    statusIcon = m("i.fas.fa-ban.mr-1")
                    statusColor = "text-secondary"
                }

                record = Object.assign({}, record)  // TODO REF: this is here to prevent original object mutation - find a better way
                record.volume_formatted = record.volume.toFixed(1) + ' m³'
                record.status_name = m("small.bold." + statusColor, [
                    statusIcon,
                    fmt('{' + record.status_name + '}'),  // TODO REF: this is the only place where this specific data_transform_callback needs fmt. find a way to get rid of it and remove this function's second argument
                ])
                // TODO: this works fine since we translate all fields but only plain strings are supported, not nested m() objects
                //record.status_name = '{' + record.status_name + '}'
                return record
            })
      },
      hideable: true,
      actions,
      display_columns,
      columnNames: {"payment_type_str": "{payment_type_name}"},
    })
}

function MyPostRequest(url, form_data, success_url, ok_callback, err_callback) {
   /* <then_callback> ...  optional func to be called when data are returned */
   console.debug("myPostRequest", url, form_data)
   m.request({ url: url, method: 'POST', body: form_data }).then((data) => {
      console.debug("myPostRequest response", url, data)
      ServerMessages.set(data)
      if (data && !data.error) {
        if (success_url) {
            m.route.set(success_url)
        }
        if (ok_callback) {
          // FIXME: this is super ugly - if you need to make some subsequent calls, make this entire thing a promise (and use .then() on that)
          ok_callback(data)
        }
      } else if (err_callback) {
          err_callback()  // TODO: actually pass the error
      }
  })
}

function isMididisp () {
  /* Some functions should work only in MIDI disp. We do not have such value in config,
       and I do not want to overcomplicate that file, so let's tie it to one of three 'basic' modules
       - at least one should be ON in MIDI version
    */
  // FIXME: this logic should not be split between backend and frontend
  return (GlobalConfig.setup.module_login || GlobalConfig.setup.module_cars || GlobalConfig.setup.module_contracts || GlobalConfig.setup.module_samples)
}

/* Very utility func. Converts list of records, that are not hidden, to simple id:name object, where name is created in mapFunc() */
function nonHiddenRecordsToNamesObject(arrayOfRecords, mapFunc) {
    let ret = {}
    for (const x of arrayOfRecords) {
      if (!Number(x.hidden)) {
         ret[x.id] = mapFunc(x)
      }
    }
    return ret
}

function recordById (id, recordList) {
  // Helper function to find a record (identified by id) in record list
  if (recordList) {
    return recordList.find(x => x.id == id)
  }
}

function DataFromFormFields (fields) {
  /* Returns hashtable from values of edit fields
    TODO REF This function seems not to work properly in some corner cases. Delete and change all it's usages
        to method used in OpenRecipe.SubmitButtton.on_click handler (using vnode.state.data, instead of
        internal state data on the components.
  */
  let ret = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value) {
        ret[key] = value.state.value
    }
  }
  return ret
}

/* Full screen msgbox. Attributes:
    title   (string in header)
    fields  (as object, displayed are only values)
    buttons (simple list)
*/
const Msgbox = {
  view: vnode => {
    return m('',
      m('.mt-5', '.'), // Naive separator
      m('.w-50.mt-5.mx-auto.bg-light.p-4.border.border-dark.rounded', [
        m('h2.my-3.text-center', vnode.attrs.title),
        vnode.attrs.fields ? formFieldsToLayout(vnode.attrs.fields) : null,
        m('.text-center.mt-4', vnode.attrs.buttons),
      ])
    )
  }
}

/* InfoBox displayed in user forms. Attrs:
        text  .. text to be displayed
        level .. [info|warning|error]
*/
const InfoBox = {
  view: vnode => {
      let levelStyle = ""
      let icon = ""
      if (vnode.attrs.level == "info") {
        levelStyle = ".border-dark"
        icon = ".text-dark.fas.fa-sticky-note"
      }
      if (vnode.attrs.level == "warning") {
        levelStyle = ".border-warning"
        icon = ".text-warning.fas.fa-exclamation-circle"
      }
      if (vnode.attrs.level == "error") {
        levelStyle = ".border-danger"
        icon = ".text-danger.fas.fa-exclamation-triangle"
      }
      return vnode.attrs.text ? m(".py-2.px-3.mx-5.my-2.bold.border.bg-light.rounded"+levelStyle, m('i.mr-2' + icon), vnode.attrs.text ) : null
  }
}

/* Hidden form field with name='lang' and value extracted from lang= parameter of URL.
   Necessary to 'transfer' language to backend in printout forms
   (otherwise backend does not know language used in URL until page is reloaded via F5 or so)
*/
const LanguageField = {
  view: vnode => {
    return m('input', { type: 'hidden', name: "lang", value: vnode.attrs.lang })
  }
}

/* Unified header row for sub-part of long UX form. Text is defined in 'children' */
const FormSubHeader = {
  view: vnode => {
     return m('.mx-3.pl-1.pb-0.pt-1.bg-light.border-bottom.my-1.bold', vnode.children )
  }
}

/* Unified header row UX forms Text is defined in 'children' */
const FormHeader = {
  view: vnode => { return m('h3.mx-3.mt-4.border-bottom.mb-3', vnode.children) }
}


/* 'Spinning wheel' displayed when loading something. Attrs:
        small = [true | false]  .. small wheel that fits into the form row
*/
const Loading = {
  view: vnode => {
    return vnode.attrs.small ?
        m('.my-1.px-1', m('img', { src: './static/spinner.gif', width: 20})) :
        m('.my-5.mx-auto.w-50.text-center', m('img', { src: './static/spinner.gif' }))
  }
}

const HideButton = { /* "Eye" icon for hiding records */
  view: vnode => { return m('i.fas.fa-eye-slash.mx-1.text-primary.bigger.my-1.pointer', { title: vnode.attrs.fmt('{Hide record}'), onclick: vnode.attrs.onclick }) }
}

const StdButton = {
  /* Simple blue button. Attrs:
        onclick
        text
  */
    view: vnode => { return m('.btn.btn-primary.px-4.mr-4', {onclick: vnode.attrs.onclick}, vnode.attrs.text) }
}

/* selectbox of payment types
   HTML selectbox does not allow 'null' as key, so alias value '99999' is used for null (means: not set). Attrs:
   onchange_callback  ... as name says
*/
const PaymentType = {
    view: vnode => {
        const fmt = vnode.attrs.fmt
        let options = { 99999: fmt('{not_set}') }
        for (const [key, value] of Object.entries(GlobalConfig.payment_types)) {
            options[key] = fmt('{' + value + '}')
        }
        return m('select', {
            onchange: e => {
                const myvalue = ((e.target.value == 99999) ? null : e.target.value)
                if (vnode.attrs.onchange_callback) {
                    vnode.attrs.onchange_callback(myvalue)
                }
            },
        }, Object.keys(options).map(k => {
            const selected = (k==99999 && vnode.attrs.value == null)
                ? 1
                : ((vnode.attrs.value == k) ? 1 : 0)
            return m('option', {selected, value: k}, options[k])
        }))
    }
}

const FormRow = {
  /* We wrap form fields into neat rows */
  view: vnode => {
    return m('.row.mx-4.py-1',
      // FIXME: noooo, don't rely on children being present and/or their count
      m('.col-sm-12.col-md-4.text-md-right', vnode.children[0]),
      m('.col-sm-12.col-md-8', vnode.children[1])
    )
  }
}

const ListButtonsArea = { /* buttons under list, always visible */
  view: vnode => {
      return m('.border-top.bg-white.fixed-bottom.d-flex.justify-content-end.pr-2', vnode.children)
  }
}


const BackButton = {  /* Button to go one page back  */
  view: vnode => {
    return m('.btn.btn-secondary.px-4.mr-2', {onclick: _e => { history.go(-1) }},
      m('.fas.fa-backward.mr-2'),
      vnode.children.length ? vnode.children : vnode.attrs.fmt('{go_back}')  // FIXME: don't abuse vnode.children here to set custom text - use attribute
    )
  }
}

const SimpleSubmitButton = {
  /* Submit button with "callback" for standard edit forms. Attributes:
        my_onclick          func to call on click
        back_button         if true, show back button as well. FIXME: Spaggethi style, change to FormSubmitArea or so
  */
  view: vnode => {
    const fmt = vnode.attrs.fmt
    return m(FormRow,
        m(''),
        m('d-flex',
            (vnode.attrs.back_button ? m(BackButton, {fmt}) : null),
            m('', {
                class: 'btn btn-primary px-4',
                onclick: _e => { vnode.attrs.my_onclick() },
            },
                m('.fas.fa-save.mr-2'),
                vnode.children.length ? vnode.children : fmt('{Save}')
            )
        )
    )
  }
}

/* Plain submit button for printout forms */
const ButtonGenerate = {
  view: vnode => {
    return m('input', {
      type: 'submit',
      class: 'btn btn-primary px-4 mr-2',
      name: "generate",
      value: vnode.attrs.fmt('{Generate}'),
    })
  }
}

/* Plain Make CSV button for printout forms */
const ButtonCSV = {
  view: vnode => {
    return m('input', {
      type: 'submit',
      class: 'dropdown-item btn btn-primary px-4 mr-2',
      name: "export_csv",
      value: vnode.attrs.fmt('{export_to_csv}'),
    })
  }
}

/* Plain Make CSV button for printout forms */
const ButtonTSV = {
  view: vnode => {
    return m('input', {
      type: 'submit',
      class: 'dropdown-item btn btn-primary px-4 mr-2',
      name: "export_tsv",
      value: vnode.attrs.fmt('{export_to_tsv}'),
    })
  }
}

/* Group of "Export to CSV" and "Export to TSV" buttons */
const ExportButtons = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const id = 'dropdown_exports'
    return m('span.dropdown', [
      m('button.btn.btn-primary.dropdown-toggle.mx-1.py-1', {
        type: 'button',
        id,
        'data-toggle': 'dropdown',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
      }, fmt("{export}")),
      m('div.dropdown-menu', { 'aria-labelledby': id }, [
          m(ButtonCSV, {fmt}),
          m(ButtonTSV, {fmt}),
      ]),
    ])
    }
}

/* Group of two buttons: Generate and Export to CSV for printout forms, wrapped in FormRow */
const PrintoutSubmitButtons = {
  view: vnode => {
      return m(FormRow,
          m(''),
          m('', [
              m(ButtonGenerate, {fmt: vnode.attrs.fmt}),
              m(ExportButtons, {fmt: vnode.attrs.fmt}),
          ])
      )
  }
}

const ButtonAdd = {
  /* Simple button to add an item. Attrs:
        href
        small   <true|false>
        onclick callback to onclick event
  */
  view: vnode => {
    const myClass = "btn btn-primary fas fa-plus" + (vnode.attrs.small ? " px-3 py-1" : " px-5 my-3 ml-3 py-2 mx-1")
    return m(m.route.Link, {
        href: vnode.attrs.href,
        class: myClass,
        onclick: vnode.attrs.onclick,
    })
  }
}

const DropdownMenu = {
  /*  Attrs:
        name .. displayed on button
    */
  view: vnode => {
    const id = 'dropdownmenu' // strangely, you can use the same ID for many dropdowns and it works...;
    return m('.dropdown',
      m('button.btn.btn-light.dropdown-toggle.mx-1.py-1.border.border-dark', {
        type: 'button',  // FIXME: what is "type"? isn't it specified in tag selector above?
        id,
        'data-toggle': 'dropdown',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
      }, vnode.attrs.name),
      m('div.dropdown-menu', { 'aria-labelledby': id }, vnode.children)
    )
  }
}

const FormPage = {
    /* Page with menu and form. Attrs:
            title .. title displayed as a header on page
    */
    view: vnode => {
        return m(Layout, { fmt: vnode.attrs.fmt }, [
          m(FormHeader, vnode.attrs.title),
          ...vnode.children,
        ])
    }
}

/* red and green strip with server errors and messages. Also acts as singleton holding last response from the server. Usage:
     ServerMessages.clear() to clear message
     ServerMessages.set(json_data) with json returned from server to display it.
   HACK: yes, this global (singleton) is ugly. But I found no other simple way to do it.
*/
const ServerMessages = {
    response: null,

    clear: () => { ServerMessages.response = null },

    set: data => {
        ServerMessages.response = data
        window.setTimeout(ServerMessages.on_interval, INTERVAL_TO_HIDE_MESSAGE)
    },

    on_interval: () => {
          if (ServerMessages.response && ServerMessages.response.message && ServerMessages.response.message.length) {
                ServerMessages.clear()
                m.redraw()  // FIXME: no forced redraws
          }
    },

    view: vnode => {
        const fmt = vnode.attrs.fmt
        const closeButton = m('span.btn.btn-dark.text-light.py-1.px-2.small.fas.fa-times', {
            onclick: _e => { ServerMessages.clear() },
        })
        if (ServerMessages.response) {
          if (ServerMessages.response.error) {
            return m('.bg-danger.p-2', closeButton, m('span.col-10', fmt(ServerMessages.response.error)) )
          }
          if (ServerMessages.response.message) {
            return m('.bg-success.p-2', closeButton, m('span.col-10', fmt(ServerMessages.response.message)) )
          }
        }
        return m("")
    }
}

// TODO: find a better name
const makeMenu = (data, fmt) => {
    return data.map(x => {
        let ret = null;
        if (x.url) {
            ret = m(m.route.Link, {
              //href: x.url,
              class: 'btn btn-light mx-1 px-1 py-1',
              onclick: (_e) => {
                m.request({
                  url: x.url,
                  method: x.method,
                  body: {},
                }).then((data) => {
                    ServerMessages.set(data)
                    if (x.to_after) {
                        m.route.set(x.to_after)
                    }
                })
              },
            }, fmt(x.name))
        } else if (x.children) {
            ret = m(DropdownMenu, { name: fmt(x.name) }, x.children.map(xx =>
                m(m.route.Link, {
                  href: xx.to,
                  class: 'dropdown-item',
                  onclick: () => { ServerMessages.clear() } // clear error or message when user clicks any menu button
                }, [
                  fmt(xx.name),
                  xx.locked ? m(".fas.fa-lock.ml-2", "") : null,
                ])
            ))
        } else {
            ret = m(m.route.Link, {
              href: x.to,
              class: 'btn btn-light mx-1 px-1 py-1',
              onclick: () => { ServerMessages.clear() } // clear error or message when user clicks any menu button
            }, fmt(x.name))
        }
        return ret
    })
}

const Layout = {
  /* Complete layout of the page. Menu, footer and all that jazz. Attrs:
            search_box   .. show search box in top menu.
            on_filter_change .. callback to call when filter text is changed. Must be specified together with search_box
  */
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const menu = makeMenu(GlobalConfig._menu, fmt)

    const CompleteMenu = m('.mb-0.mx-0.p-0.sticky-top',
      m('.row.border-bottom.border-dark.m-0',
        m('.col-12.bg-secondary.pt-2.pb-2.d-flex.flex-wrap.pl-2', [
          m('span.ml-0.mr-2',
            m('img', { src: 'static/asterix-logo.png', height: '35' }, '')  // FIXME: why empty string here?
          ),
          ...menu,
          vnode.attrs.search_box
              ? m(FilterField, { on_filter_change: vnode.attrs.on_filter_change })
              : '',
        ])
      ),
      m(ServerMessages, { fmt }),
    )

    return m('', [
      CompleteMenu,
      m(".pl-2.pr-3", vnode.children),
      m('.mt-4')
    ])
  }
}

const FilterField = {
  /* Edit box for filtering context. Attrs:
     on_filter_change .. callback to call when filter text is changed
  */
  view: vnode => {
    return m('.ml-4', [
      m('.text-white.ml-3.mr-2.fas.fa-search.py-2'),
      m('input', {
        value: vnode.state.value,
        id: 'filter_input',
        onkeyup: e => {
          const v = e.target.value.trim()
          if (v !== vnode.state.value) {
              vnode.state.value = v
              vnode.attrs.on_filter_change(v)
          } else {
              e.redraw = false
          }
        },
      }),
    ])
  }
}

const MultilineField = {
  /* Generic multiline text input field. Attrs:
        required   .. warn if value is empty
        title      .. human-readable name of form field. Purpose: to be displayed on left, or as a hint
        placeholder
        onchange_callback
  */
  oninit: vnode => {
    vnode.state.error_message = ''
    vnode.state.input_valid = true
    vnode.state.value = vnode.attrs.value
  },

  validate: (vnode, e) => {
    const fmt = vnode.attrs.fmt
    vnode.state.error_message = ''
    vnode.state.input_valid = true
    vnode.state.value = (e.target.value === '') ? null : e.target.value

    if (vnode.attrs.required && !(vnode.state.value)) {
      vnode.state.input_valid = false
      vnode.state.error_message = fmt('{Value required}')
    }

    if (vnode.attrs.onchange_callback) {
        vnode.attrs.onchange_callback(vnode.state.value)
    }
  },

  view: vnode => {
    const warning = vnode.state.input_valid ? m('') : m('span.text-danger.ml-2', vnode.state.error_message)
    const warningBorderClass = vnode.state.input_valid ? '' : 'border-danger'
    return m('', [
        m('span', [
          m('textarea', {
            class: warningBorderClass,
            value: vnode.state.value,
            placeholder: vnode.attrs.placeholder,
            onchange: e => { MultilineField.validate(vnode, e) },
            onfocusout: e => { MultilineField.validate(vnode, e) },
          }),
        ]),
        warning,
    ])
  }
}

const InputField = {
  /* Generic input field with validations. Attrs:
        number     .. warn if value is not a number
        integer    .. warn if value is not an integer number
        password   .. as name says
        required   .. warn if value is empty
        size       .. size of input box
        full_width .. stretch input field to 100%
        name       .. name of form field. Necessary only for GET forms (printouts)
        title      .. human-readable name of form field. Purpose: to be displayed on left, or as a hint
        disabled   .. if the field is disabled, default false. Copied to state, so can be changed later.
        placeholder
        hint
        onchange_callback
  */
  oninit: vnode => {
    vnode.state.error_message = ''
    vnode.state.input_valid = true
    vnode.state.value = vnode.attrs.value
    //vnode.state.disabled = vnode.attrs.disabled
  },

  validate: (vnode, e) => {
    const fmt = vnode.attrs.fmt
    vnode.state.error_message = ''
    vnode.state.input_valid = true
    if (vnode.attrs.number) { // Field must support both decimal , and .
      e.target.value = e.target.value.replace(',', '.')
    }
    vnode.state.value = (e.target.value === '') ? null : e.target.value

    if (vnode.attrs.number && isNaN(vnode.state.value)) {
      vnode.state.input_valid = false
      vnode.state.error_message = fmt('{Number required}')
    }

    if (vnode.attrs.integer && !isInteger(vnode.state.value)) {
      vnode.state.input_valid = false
      vnode.state.error_message = fmt('{Integer required}')
    }

    if (vnode.state.input_valid && vnode.attrs.required && !(vnode.state.value)) {
      vnode.state.input_valid = false
      vnode.state.error_message = fmt('{Value required}')
    }

    if (vnode.attrs.onchange_callback) {
        vnode.attrs.onchange_callback(vnode.state.value)
    }
  },

  view: vnode => {
    return m('', [
      m('input' + (vnode.attrs.full_width ? ".w-100" : "") + (vnode.state.input_valid ? '' : '.border-danger'), {
        name: vnode.attrs.name,
        //disabled: vnode.state.disabled,
        disabled: vnode.attrs.disabled,
        value: vnode.attrs.value,
        placeholder: vnode.attrs.placeholder,
        size: vnode.attrs.size,
        type: vnode.attrs.password ? 'password' : 'text',
        onchange: e => { InputField.validate(vnode, e) },
        onfocusout: e => { InputField.validate(vnode, e) },
      }),
      m(Hint, vnode.attrs.hint),
      vnode.state.input_valid ? null : m('span.text-danger.ml-2', vnode.state.error_message),
    ])
  }
}

/*  Neatly formatted row for forms, title on the left, field on the right.
    attrs: field: formfield to display
             title to be displayed on the left is taken from field "title" attribute
*/
const InputFormRow = {
  view: vnode => {
    const f = vnode.attrs.field
    return f
      ? m(FormRow,
          m("span" + (f.attrs.required ? '.bold' : ''), f.attrs.title + ':'),
          f,
      )
      : m(FormRow,
          m("span", ""),
          m(""),
      )
  }
}

const Hint = {
  /* Shows simple hint in form of yellow question mark and popup text */
  view: vnode => {
    if (vnode.children.length) {
      return m('.btn.btn-warning.ml-2.py-1.px-2.rounded-circle.fas.fa-question', {
          title: vnode.children,  // FIXME: this looks like an ugly hack - use attrs
      }, '')
    } else {
      return m('')
    }
  }
}

const CheckBox = {
  /* Attrs:
       value
       onchange_callback  .. function to be called when state of checkbox is changed
   */
  oninit: vnode => {
    vnode.state.value = ('value' in vnode.attrs) ? vnode.attrs.value : false
  },
  view: vnode => {
    // TODO: ugly hack
    const ItemId = vnode.children.toString().replace(/ /g, '_').toLowerCase()
    return m(FormRow,
      m('span'),
      m('',
        m('span', [
          m('input', {
            value: 1,  // TODO: ?
            id: ItemId,
            type: 'checkbox',
            checked: vnode.state.value,
            onchange: e => {
              vnode.state.value = e.target.checked
              if (vnode.attrs.onchange_callback) {
                vnode.attrs.onchange_callback(vnode.state.value)
              }
            }
          }),
          m('label.ml-2', { for: ItemId }, vnode.children),
          m(Hint, vnode.attrs.hint),
        ])
      ),
    )
  }
}

const CheckBox2 = {
  /* Attrs:
       value
       onchange_callback  .. function to be called when state of checkbox is changed
   */
  view: vnode => {
    //const ItemId = vnode.children.toString().replace(/ /g, '_').toLowerCase()
    const itemId = vnode.attrs.label.replace(/ /g, '_').toLowerCase()
    return m("", [
      m("input", {
        id: itemId,
        type: "checkbox",
        checked: vnode.attrs.value === true ? true : false,
        onchange: e => {
          if (vnode.attrs.onchange_callback) {
            //console.debug("HOVNO", e)
            //vnode.attrs.onchange_callback(e.target.checked === true ? true : false)
            vnode.attrs.onchange_callback(e.target.checked)
          }
        }
      }),
      //m("label.ml-2", { for: itemId }, vnode.children),
      m("label.ml-2", { for: itemId }, vnode.attrs.label),
      m(Hint, vnode.attrs.hint),
    ])
  }
}

const SmartSelectBox = {
  /* Smarter select box. Values can be filtered
        onchange_callback ... function to call when value of select box is changed
        title ... human-readable name of field (typically to be displayed left to the select box)
        autofocus .. set focus to itself when containing "page" is activated
        field_name .. name of the text field. necessary only in GET requests
    */
  oninit: vnode => {
    // numerical ID of selected record
    vnode.state.value = ('value' in vnode.attrs) ? vnode.attrs.value : 0
  },

  on_change: vnode => {
    if (vnode.attrs.onchange_callback) {
      vnode.attrs.onchange_callback(vnode.state.value)
    }
  },

  // handles autofocus behavior. Mithril doesn't have method to set focus on page change, so this is kind of HACK
  oncreate: vnode => {
    if (vnode.attrs.autofocus) {
      vnode.state.input_field.dom.focus()
    }
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const init_value = ('value' in vnode.attrs) ? vnode.attrs.value : 0
    const initialValue = init_value ? vnode.attrs.options[Number(init_value)] : ''

    const dataListOptions = Object.entries(vnode.attrs.options).map(([k, v]) =>  m('option', {
        selected: (k == vnode.state.value) ? 1 : 0,
        value: v,
        dataid: k,
    }, v))

    const listId = 'datalist_options_' + vnode.attrs.title.replace(/ /g, '_').toLowerCase() // construct unique ID

    // FIXME: don't set state in view
    vnode.state.input_field = m('input.w-100', {
      type: 'text',
      list: listId,
      placeholder: fmt('{search_placeholder}'),
      name: vnode.attrs.field_name,
      value: initialValue,
      onchange: e => {
        // datalist has no option to simply copy id into textfield, so extract it manually via "dataid" attribute - FIXME: whoa! "document.???" is a big no no!
        const selectedOption = document.querySelector('#' + listId + " option[value='" + e.target.value + "']")
        vnode.state.value = selectedOption ? selectedOption.getAttribute('dataid') : e.target.value
        SmartSelectBox.on_change(vnode)
      },
    })

    return m('.d-flex', [
        m('.w-100', [
          vnode.state.input_field,
          m('datalist', { id: listId }, dataListOptions)
        ]),
        m('.ml-2', vnode.children)
    ])
  }
}

const SmartSelectBox2 = {
  /* Smarter select box. Values can be filtered
        onchange_callback ... function to call when value of select box is changed
        autofocus .. set focus to itself when containing "page" is activated
        field_name .. name of the text field. necessary only in GET requests
    */
  /*oninit: vnode => {
    // numerical ID of selected record
    vnode.state.value = ('value' in vnode.attrs) ? vnode.attrs.value : 0
  },*/

  // handles autofocus behavior. Mithril doesn't have method to set focus on page change, so this is kind of HACK
  oncreate: vnode => {
    if (vnode.attrs.autofocus) {
      vnode.state.input_field.dom.focus()
    }
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    let theValue = ""
    for (x of vnode.attrs.options) {
        if (x.id !== null && x.id == vnode.attrs.value) {
            theValue = x.title
            break
        }
    }

    const dataListOptions = vnode.attrs.options.map(x =>  m('option', {
        selected: x.id === vnode.attrs.value,
        value: x.title ? fmt(x.title) : "",
        dataid: anyToStr(x.id),
    }, x.title ? fmt(x.title) : "------"))  // TODO: make the dashes a constant

    const listId = 'datalist_options_' + vnode.attrs.field_name // construct unique ID

    // FIXME: don't set state in view
    vnode.state.input_field = m('input.w-100', {
      type: 'text',
      list: listId,
      placeholder: fmt('{search_placeholder}'),
      name: vnode.attrs.field_name,
      value: theValue,
      onchange: e => {
        let v = null
        for (x of e.target.list.children) {
            if (x.value === e.target.value) {
                v = strToAny(x.attributes.dataid.value)
                break
            }
        }
        if (vnode.attrs.onchange_callback) {
          vnode.attrs.onchange_callback(v)
        }
      },
    })

    return m('.d-flex', [
        m('.w-100', [
          vnode.state.input_field,
          m('datalist', { id: listId }, dataListOptions)
        ]),
        m('.ml-2', vnode.children)
    ])
  }
}

const SimpleSelectBox = {
  /* More or less just wrap of a standard select box. Attrs:
        options             .. hashtable { "id" => "name1", ... }
        values_as_names     .. state.value will be text on option, not a numerical value of it
        onchange_callback   .. called on change, as: onchange_callback(value)
        empty_option        .. if True, adds "----" option to the top, which has value "null"
        field_name .. name of the text field. necessary only in GET requests
  */

  value: null,

  oninit: vnode => {
    console.debug("SimpleSelectBox.oninit", vnode)
    vnode.state.value = vnode.attrs.value ? vnode.attrs.value : (vnode.attrs.empty_option ? null : 0)
  },

  view: vnode => {
    console.debug("SimpleSelectBox.view", vnode)
    const emptyOptionString = "------"  // TODO: make this constant
    return m('select', {
        name: vnode.attrs.field_name,
        onchange: e => {
          if (vnode.attrs.values_as_names) {
            vnode.state.value = vnode.attrs.options[parseInt(e.target.value)]
          } else {
            if (vnode.attrs.empty_option && e.target.value==emptyOptionString) {
                vnode.state.value = null
            } else {
                vnode.state.value = e.target.value
            }
          }
          if (vnode.attrs.onchange_callback) {
             vnode.attrs.onchange_callback(vnode.state.value)
          }
        }
      },
      vnode.attrs.empty_option ? m('option', {value: null}, emptyOptionString) : null,
      // FIXME: does this depend on key ordering?
      Object.keys(vnode.attrs.options).map((k) => {
        let selected = false
        if (vnode.attrs.values_as_names) {
          selected = vnode.state.value == vnode.attrs.options[k] ? 1 : 0
        } else {
          selected = vnode.state.value == k ? 1 : 0
        }
        return m('option', {
          selected,
          value: k
        }, vnode.attrs.options[k])
      })
    )
  }
}

const SimpleSelectBox2 = {
  /* More or less just wrap of a standard select box. Attrs:
        onchange_callback   .. called on change, as: onchange_callback(value)
  */

  view: vnode => {
    console.debug("SimpleSelectBox2.view", vnode)
    const fmt = vnode.attrs.fmt
    const emptyOptionString = "------"  // TODO: make this constant
    return m('select', {
        onchange: e => {
          if (vnode.attrs.onchange_callback) {
              // TODO: maybe convert back to original type? (int?)
              vnode.attrs.onchange_callback(strToAny(e.target.value))
              //vnode.attrs.onchange_callback(e.target.value === "" ? null : e.target.value)
          }
        }
      },
      vnode.attrs.options.map(x => {
        return m('option', {
          selected: x.id === vnode.attrs.value,
          value: anyToStr(x.id),
        }, x.title ? fmt(x.title) : emptyOptionString)
      })
    )
  }
}


const Line = {
/* One line in list view. Attributes:
    record  .. record to display
    columns .. list of column names (from record) to display
    url_open .. base part of url to open, when row is clicked; Record.id is added to this. If set, displays 'edit' icon.
    delete_callback .. function to be called when Delete button is clicked. If set, displays 'delete' icon. Called as delete_callback(record.id)
    hide_callback .. ditto for hide record. If set, displays 'hide' icon. Not required.
    actions       .. list of additional actions to be displayed as buttons in "actions" column. Format is the same as in ListView

    Shows line in dark color, if record.hidden column  is true
*/
  view: vnode => {
    const OpenUrl = vnode.attrs.url_open ? (vnode.attrs.url_open + vnode.attrs.record.id) : null
    let columns = []
    const hidden = vnode.attrs.record.hidden === true
    const tag = 'td.py-0.px-1' + (hidden ? '.italic.bg-secondary.text-white' : '')
    const fmt = vnode.attrs.fmt

    for (const k of vnode.attrs.columns) {
      // FIXME: ternary operator for this? get rid of "let"
      let v = vnode.attrs.record[k]
      // Display boolean variables in a sane way
      if (v === true) {
        v = '{Yes}'
      } else if (v === false) {
        v = '{No}'
      }
      columns.push(m(tag, fmt(v)))
    }

    let actionIcons = []
    if (OpenUrl) {
      // FIXME: make this proper link (a href)?
      actionIcons.push(m('i.mx-1.my-1.bigger.text-primary.fas.fa-edit.pointer', {
          title: fmt('{Edit record}'),
          onclick: _e => { m.route.set(OpenUrl) },
      }))
    }
    if (vnode.attrs.actions) {
      for (const action of vnode.attrs.actions) {
        // FIXME: use "continue" strategy (just as below)
        if (action) {
            if (action.constraint && !action.constraint(vnode.attrs.record)) {
                continue
            }
            if (action.url) {
                const url = action.url.replace(':id', vnode.attrs.record.id)
                // FIXME: make this proper link (a href)?
                actionIcons.push(m('i.mx-1.my-1.bigger.text-primary.' + action.icon, {
                    title: action.name,
                    onclick: () => { m.route.set(url) },
                }))
            } else if (action.href) {
                const url = action.href.replace(':id', vnode.attrs.record.id)
                actionIcons.push(m('a.mx-1.my-1.bigger.text-primary.' + action.icon, {
                    title: action.name,
                    href: url,
                    target: "_blank",
                }))
            } else if (action.callback) {
                actionIcons.push(m('a.mx-1.my-1.bigger.text-primary.' + action.icon, {
                    title: action.name,
                    onclick: _e => { action.callback(vnode, vnode.attrs.record) },
                    target: "_blank",
                }))
            } else {
                console.debug("No action set", action)
            }
        }
      }
    }
    if (vnode.attrs.hide_callback) {
      actionIcons.push(m(HideButton, {
          fmt,
          onclick: () => { vnode.attrs.hide_callback(vnode.attrs.record.id) },
      }))
    }
    if (vnode.attrs.delete_callback) {
      actionIcons.push(m('i.mx-1.my-1.bigger.fas.fa-trash.text-danger.pointer', {
          title: fmt('{Delete record}'),
          onclick: () => { vnode.attrs.delete_callback(vnode.attrs.record.id) },
      }))
    }

    if (actionIcons.length) {  // prevent empty column, if no actions are defined
        columns.push(m(tag, actionIcons))
    }

    return m('tr', columns)
  }
}

const ColumnHeader = {
/*  For listviews. Changes sort order by click. Attrs:
        name                name of column (model field name, e.g. "volume"
        on_sort_change      callback. Receives (sort_by) argument - string in endpoint format, e.g. "volume" or "!volume"
        list_order_string   actual ListView ordering in endpoint format. Can be this column name or other column name.
                            If this matches actual column, header is initialized to reflect this ordering
        sortable            As name says (bool)
*/
    oninit: vnode => {
        if (vnode.attrs.list_order_string) {
            const orderColumnName = vnode.attrs.list_order_string.startsWith("!") ? vnode.attrs.list_order_string.substring(1) : vnode.attrs.list_order_string
            if (orderColumnName == vnode.attrs.name) {
                const reversed = vnode.attrs.list_order_string.startsWith("!")  // FIXME: do we really need this line? ;-)
                vnode.state.order_by = reversed ? "D" : "A"  // FIXME: this is not "order by" - this is "sort order" (no by) - also, something like "DESC"/"ASC" would be more obvious
            }
        }
    },

    view: vnode => {
        const columnName = vnode.attrs.displayName
        // TODO REF: try the ellipsis css style for this - does not really work (try the prepared .ellipsis class and "vehicles" list to see how it looks - find something more elegant -> maybe see this: https://stackoverflow.com/questions/26973570/setting-a-max-character-length-in-css
        // Long column names break up UX layout, so here is ellipsis to (more or less arbitrary) length
        const columnNameTrimmed = (columnName.length > 20) ? (columnName.substring(0, 20) + "...") : columnName
        const customFormat = vnode.attrs.sortable ?
            (vnode.state.order_by ? ".bg-light.text-dark" : "") :
            ".italic"
        const downArrow = (vnode.state.order_by == "D") ? m("i.fas.fa-sort-down.pl-2") : null
        const upArrow = (vnode.state.order_by == "A") ? m("i.fas.fa-sort-up.pl-2") : null

        return m('th.p-1' + customFormat, { onclick: _e => {
            if (vnode.attrs.sortable) {
                if (vnode.state.order_by == "A") {
                    vnode.state.order_by = "D"
                } else {
                    vnode.state.order_by = "A"
                }
                const sortString = ((vnode.state.order_by == "A") ? "" : "!") + vnode.attrs.name
                vnode.attrs.on_sort_change(sortString)
                // FIXME: so we're setting the state above and then call a function with will reload all data? how is the state even used?
                // FIXME: do we really need to convert between "!" and "D"/"A"?
            }
        }}, [columnNameTrimmed, downArrow, upArrow])
    }
}

const ListView = {
/* Universal list supporting list of items, open detail, delete item, search. Attributes:
    select_endpoint .. url of API endpoint to get data for list of records.
                       if not specified, ListView uses endpoint select/<model_name>
    delete_endpoint .. slug of URL of API endpoint to delete record. ListView adds "/<record_id>" to the end.
                       If not specified, ListView will use endpoint "delete/<model_name>/<record_id>"
    delete_disabled .. if set to true, delete button is not shown
    model_name      .. name of model in DB
    order_by        .. sort by this key (prefix with "!" to reverse order)
    detail_url      .. base part of url to display detail or to add new record, must end with "/"
    display_columns .. list of column names that will be displayed and filtered against. e.g. ["name", "surname"]
    columnNames     .. optional map of column_name => column_string_to_be_shown_in_header (defaults to "{column_name}" for missing items). this is useful for cases when column name is not same as the string used for translation.
                       If there is a column named "hidden", ListView has feature to show/hide records
    actions         .. list of additional actions to be displayed as buttons in "actions" column. Every action is hashtable:
                            name: name displayed as hint
                            url: url, where :id part is replaced with actual :id of the record
                            href: set it instead of url for direct hrefs outside mithrill, for example for printouts
                            callback: set it instead of url or href. Will be called on click, as: callback(vnode, record)
                            icon: icon definition in dot notation (e.r. "fas.fa-eye")
                            constraint: callback function called as constraint(record). Action icon is displayed only if this function returns true
    data_transform_callback   .. (optional) function, called after data are loaded (can transform data, e.g. translate something)
    hideable     .. is this list hideable?
*/
  oninit: vnode => {
    console.debug("ListView.oninit", vnode)
    vnode.state.data = {}
    vnode.state.filter_string = ''
    vnode.state.show_hidden = false
    ListView.loadData(vnode)
  },

  loadData: vnode => {
    console.debug("ListView.loadData", vnode)
    vnode.state.is_loading = true
    const orderByString = vnode.state.order_by || vnode.attrs.order_by  // ordering selected by user has precedence
    const url = (vnode.attrs.select_endpoint ? vnode.attrs.select_endpoint : ('select/' + vnode.attrs.model_name))
        + (orderByString ? ("/" + orderByString ) : "")
    m.request({ url: url }).then(data => {
      console.debug("ListView.loadData response", data)
      // TODO REF: remove this after the the transform mess is cleaned
      /*if (vnode.attrs.data_transform_callback) {
        vnode.state.data.data = vnode.attrs.data_transform_callback(data.data)
      } else {
        vnode.state.data = data
      }*/
      vnode.state.data = data
      vnode.state.is_loading = false
    }).catch(err => {
        if (err.code === 401) {
            m.route.set("/login")
        }
        vnode.state.data = {}
    })
  },

  /* delete record after confirmation */
  on_delete: (vnode, id) => {
    const fmt = vnode.attrs.fmt
    const CustomUrl = vnode.attrs.delete_endpoint ? vnode.attrs.delete_endpoint : ('delete/' + vnode.attrs.model_name)
    if (window.confirm(fmt('{Delete this record?}')) === true) {
      m.request({ url: CustomUrl + '/' + id, method: 'POST' })
        .then(data => {
          ServerMessages.set(data)
          ListView.loadData(vnode)
        }
      )
    }
  },

  toggleHidden: (vnode, id) => {
    m.request({ url: 'toggle_hidden/' + vnode.attrs.model_name + '/' + id, method: 'POST' })
      .then(data => {
        ServerMessages.set(data)
        ListView.loadData(vnode)
      })
  },

  toFilterString: (columns, record) => {
    return columns.map(c => record[c]).join("")
  },

  view: vnode => {
    console.debug("ListView.view", vnode)
    const fmt = vnode.attrs.fmt
    const filterItems = []
    const tableLocked = userLocks.isLocked(vnode.attrs.model_name)
    const data = vnode.state.data.data
    if (data) {
      // TODO REF: this used to be called in loadData (which makes more sense because it's a one-time transformation) but unfortunately, we need fmt (just in one case, tho) so it needs to be called here
      // TODO REF: passing fmt is ugly - also, data_transform_callback is defined and single argument function in most places
      const data2 = vnode.attrs.data_transform_callback ? vnode.attrs.data_transform_callback(data, fmt) : data
      for (const x of data2) {
        // FIXME REF: use "continue" strategy
        if (!x.hidden || vnode.state.show_hidden) {
          filterItems.push([
              ListView.toFilterString(vnode.attrs.display_columns, x),
              m(Line, {
                fmt,
                record: x,
                actions: vnode.attrs.actions,
                columns: vnode.attrs.display_columns,
                url_open: tableLocked ? null : vnode.attrs.detail_url,
                delete_callback: (vnode.attrs.delete_disabled || tableLocked) ? null : (id => { ListView.on_delete(vnode, id) }),
                hide_callback: (vnode.attrs.hideable && !tableLocked) ? (id => { ListView.toggleHidden(vnode, id) }) : null }),
          ])
        }
      }
    }

    const MyColumnNames = [].concat(vnode.attrs.display_columns, ['action'])  // FIXME: spread operator here?
    const columns = []
    for (const k of MyColumnNames) {
        let sortable = false
        try {
            sortable = GlobalConfig.models[vnode.attrs.model_name].sortable_columns.includes(MyColumnNames[i])
        } catch {
            // FIXME: silent catch? - anyway, is there any exception-free solution?
        }
        const columnNames = vnode.attrs.columnNames || {}
        const displayName = fmt(columnNames[k]) || fmt("{" + k + "}")
        columns.push(m(ColumnHeader, {
          sortable,
          name: k,
          displayName,
          list_order_string: vnode.state.order_by,
          on_sort_change: sortString => {
            vnode.state.order_by = sortString
            ListView.loadData(vnode)
          },
        }))
    }

    // TODO REF: just do the filtering when pushing to filterItems and get rid of the final .map()
    const rows = filterItems.filter(x => my_normalize(x[0]).includes(my_normalize(vnode.state.filter_string))).map(x => x[1])

    return m('', {}, [
      vnode.state.is_loading
        ? m(Loading)
        : m('table.pl-2.table.table-bordered.table-striped.mx-0', { style: 'width:100%;' }, [
            m('thead.thead-dark', m("tr", columns)),
            m('tbody', rows),
          ]),
    ])
  }
}

const ListView2 = {
/* Universal list supporting list of items, open detail, delete item, search. Attributes:
    select_endpoint .. url of API endpoint to get data for list of records.
                       if not specified, ListView uses endpoint select/<model_name>
    delete_endpoint .. slug of URL of API endpoint to delete record. ListView adds "/<record_id>" to the end.
                       If not specified, ListView will use endpoint "delete/<model_name>/<record_id>"
    delete_disabled .. if set to true, delete button is not shown
    model_name      .. name of model in DB
    order_by        .. sort by this key (prefix with "!" to reverse order)
    detail_url      .. base part of url to display detail or to add new record, must end with "/"
                       If there is a column named "hidden", ListView has feature to show/hide records
    actions         .. list of additional actions to be displayed as buttons in "actions" column. Every action is hashtable:
                            name: name displayed as hint
                            url: url, where :id part is replaced with actual :id of the record
                            href: set it instead of url for direct hrefs outside mithrill, for example for printouts
                            callback: set it instead of url or href. Will be called on click, as: callback(vnode, record)
                            icon: icon definition in dot notation (e.r. "fas.fa-eye")
                            constraint: callback function called as constraint(record). Action icon is displayed only if this function returns true
    data_transform_callback   .. (optional) function, called after data are loaded (can transform data, e.g. translate something)
    hideable     .. is this list hideable?
*/
  oninit: vnode => {
    console.debug("ListView2.oninit", vnode)
    vnode.state.data = []
    vnode.state.columns = []
    vnode.state.filter_string = vnode.attrs.filter_string
    vnode.state.show_hidden = vnode.attrs.show_hidden
    ListView2.loadData(vnode)
  },

  // TODO: this is being called from "outside" - solve better
  on_filter_change: (vnode, v) => {
      console.debug("ListView2.on_filter_change", v)
      vnode.state.filter_string = v
      ListView2.loadData(vnode)
  },

  on_show_hidden_change: (vnode, v) => {
      console.debug("ListView2.on_show_hidden_change", v)
      vnode.state.show_hidden = v
      ListView2.loadData(vnode)
  },

  loadData: vnode => {
    console.debug("ListView2.loadData", vnode)
    vnode.state.is_loading = true
    const orderByString = vnode.state.order_by || vnode.attrs.order_by  // ordering selected by user has precedence
    const url = (vnode.attrs.select_endpoint ? vnode.attrs.select_endpoint : ('select2/' + vnode.attrs.model_name))
    m.request({
        url: url,
        params: {
            query: vnode.state.filter_string,
            show_hidden: vnode.state.show_hidden,
            order_by: orderByString,
        },
    }).then(data => {
      console.debug("ListView2.loadData response", data)
      // TODO REF: remove this after the the transform mess is cleaned
      /*if (vnode.attrs.data_transform_callback) {
        vnode.state.data.data = vnode.attrs.data_transform_callback(data.data)
      } else {
        vnode.state.data = data
      }*/
      vnode.state.data = data.data
      vnode.state.columns = data.columns
      vnode.state.is_loading = false
    }).catch(err => {
        if (err.code === 401) {
            m.route.set("/login")
        }
        vnode.state.data = []
        vnode.state.columns = []
    })
  },

  /* delete record after confirmation */
  on_delete: (vnode, id) => {
    const fmt = vnode.attrs.fmt
    const CustomUrl = vnode.attrs.delete_endpoint ? vnode.attrs.delete_endpoint : ('delete/' + vnode.attrs.model_name)
    if (window.confirm(fmt('{Delete this record?}')) === true) {
      m.request({ url: CustomUrl + '/' + id, method: 'POST' })
        .then(data => {
          ServerMessages.set(data)
          ListView2.loadData(vnode)
        }
      )
    }
  },

  toggleHidden: (vnode, id) => {
    m.request({ url: 'toggle_hidden/' + vnode.attrs.model_name + '/' + id, method: 'POST' })
      .then(data => {
        ServerMessages.set(data)
        ListView2.loadData(vnode)
      })
  },

  /*toFilterString: (columns, record) => {
    return columns.map(c => record[c]).join("")
  },*/

  view: vnode => {
    console.debug("ListView2.view", vnode)
    const fmt = vnode.attrs.fmt
    let unhiddenItems = []
    const tableLocked = userLocks.isLocked(vnode.attrs.model_name)
    const data = vnode.state.data
    if (data) {
      // TODO REF: this used to be called in loadData (which makes more sense because it's a one-time transformation) but unfortunately, we need fmt (just in one case, tho) so it needs to be called here
      // TODO REF: passing fmt is ugly - also, data_transform_callback is defined and single argument function in most places
      const data2 = vnode.attrs.data_transform_callback ? vnode.attrs.data_transform_callback(data, fmt) : data
      for (const x of data2) {
        // FIXME REF: use "continue" strategy
        if (!x.hidden || vnode.state.show_hidden) {
          unhiddenItems.push(/*[
              ListView2.toFilterString(vnode.state.columns.map(x => x.k), x),
              */m(Line, {
                fmt,
                record: x,
                actions: vnode.attrs.actions,
                columns: vnode.state.columns.map(x => x.k),
                url_open: tableLocked ? null : vnode.attrs.detail_url,
                delete_callback: (vnode.attrs.delete_disabled || tableLocked) ? null : (id => { ListView2.on_delete(vnode, id) }),
                hide_callback: (vnode.attrs.hideable && !tableLocked) ? (id => { ListView2.toggleHidden(vnode, id) }) : null }),
          /*]*/)
        }
      }
    }

    const myColumns = [].concat(vnode.state.columns, {k: 'action', title: "{action}"})  // FIXME: spread operator here?
    const columns = []
    for (const x of myColumns) {
        let sortable = true
        try {
            sortable = GlobalConfig.models[vnode.attrs.model_name].sortable_columns.includes(MyColumnNames[i])
        } catch {
            // FIXME: silent catch? - anyway, is there any exception-free solution?
        }
        columns.push(m(ColumnHeader, {
          sortable,
          name: x.k,
          displayName: fmt(x.title),
          list_order_string: vnode.state.order_by,
          on_sort_change: sortString => {
            console.debug("on_sort_change", sortString)
            vnode.state.order_by = sortString
            ListView2.loadData(vnode)
          },
        }))
    }

    // TODO REF: just do the filtering when pushing to filterItems and get rid of the final .map()
    //const rows = unhiddenItems.filter(x => my_normalize(x[0]).includes(my_normalize(vnode.attrs.filter_string))).map(x => x[1])
    const rows = unhiddenItems

    return m('', {}, [
      vnode.state.is_loading
        ? m(Loading)
        : m('table.pl-2.table.table-bordered.table-striped.mx-0', { style: 'width:100%;' }, [
            m('thead.thead-dark', m("tr", columns)),
            m('tbody', rows),
          ]),
    ])
  }
}

const HiddenRecordsCheckBox = {
  /* Simple checkbox shown under record list, to display hidden records. Attrs:
       onchange  .. function to be called when state of checkbox is changed
   */
  view: vnode => {
    const fmt = vnode.attrs.fmt
    return m('span', [
        m('input', {
            id: "hidden_records_chb",
            type: 'checkbox',
            onchange: e => { vnode.attrs.onchange(e.target.checked) },
        }),
        m('label.ml-2', { for: "hidden_records_chb" }, fmt('{Show hidden records}')),
    ])
  }
}

const ListLayout = {
/* Page supporting ListView, which must be passed as a first child
    add_url      .. base part of url to display detail or to add new record, must end with "/"
                    if not set, ListLayout will not display "add" icon
    buttons      .. additional buttons to be displayed under list
    hideable     .. is this list hideable?
*/

  filter_changed: (vnode, status) => {
    ListLayout.show_hidden = status
    vnode.children[0].state.show_hidden = status
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const hiddenCheckbox = vnode.attrs.hideable
      ? m('.p-0.small.my-3',
          m(HiddenRecordsCheckBox, {
              fmt,
              onchange: status => { ListLayout.filter_changed(vnode, status) },
          }))
      : m('')
    return m(Layout, {
        fmt,
        search_box: true,
        on_filter_change: x => { vnode.children[0].state.filter_string = x },  // FIXME: don't rely on specific children shape
    }, [
      ...vnode.children,
      m('.my-5.py-2', ''), // Naive spacer - otherwise ListButtonsArea would cover last two or so records
      m(ListButtonsArea, [
        m('', hiddenCheckbox),
        vnode.attrs.buttons,  // FIXME: spread operator here?
        vnode.attrs.add_url
          ? m('', m(ButtonAdd, { href: vnode.attrs.add_url }))
          : null,
      ]),
    ])
  }
}

const ListLayout2 = {
/* Page supporting ListView, which must be passed as a first child
    add_url      .. base part of url to display detail or to add new record, must end with "/"
                    if not set, ListLayout will not display "add" icon
    buttons      .. additional buttons to be displayed under list
    hideable     .. is this list hideable?
    on_filter_change
    on_show_hidden_change
*/

  //show_hidden_changed: (vnode, v) => {
    //ListLayout.show_hidden = v
    //vnode.state.show_hidden = v
    //vnode.children[0].state.show_hidden = v
  //},

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const showHiddenCheckbox = vnode.attrs.hideable
      ? m('.p-0.small.my-3',
          m(HiddenRecordsCheckBox, {
              fmt,
              //onchange: x => { ListLayout.show_hidden_changed(vnode, x) },
              onchange: vnode.attrs.on_show_hidden_change,
          }))
      : m('')
    return m(Layout, {
        fmt,
        search_box: true,
        //on_filter_change: x => { vnode.children[0].state.filter_string = x },  // FIXME: don't rely on specific children shape
        on_filter_change: vnode.attrs.on_filter_change,
    }, [
      ...vnode.children,
      m('.my-5.py-2', ''), // Naive spacer - otherwise ListButtonsArea would cover last two or so records
      m(ListButtonsArea, [
        m('', showHiddenCheckbox),
        vnode.attrs.buttons,  // FIXME: spread operator here?
        vnode.attrs.add_url
          ? m('', m(ButtonAdd, { href: vnode.attrs.add_url }))
          : null,
      ]),
    ])
  }
}

/* Edit row for one surcharge, used in Expeditions and openorder. Attrs:
        endpoint .. API endpoint to obtain list of surcharges
        surcharge .. surcharge to be edited
        ondelete .. MANDATORY called back when surcharge is deleted, with 'to be deleted' surcharge as parameter
        onchange_callback .. called back with changed surcharge as parameter
*/
const Surcharge = {
    oninit: vnode => {
        m.request({ url: vnode.attrs.endpoint }).then(data => { vnode.state.list_of_surcharges = data.data })
    },

    view: vnode => {
        const surcharge = vnode.attrs.surcharge
        const fmt = vnode.attrs.fmt
        const surchargeList = vnode.state.list_of_surcharges ? Object.values(vnode.state.list_of_surcharges) : []
        const options = surchargeList.map( x => m('option', { value: x.id, selected: x.name === surcharge.name ? 1 : 0 }, x.name))
        const DeleteButton = (surcharge.id === null)
          ? m('')
          : m('.col-1.text-right.fas.fa-trash.text-danger', { onclick: _e => { vnode.attrs.ondelete(surcharge) } }, '')

        // Information text, how price was calculated
        let surchargeInfo = null
        if (surcharge.price_type == 0 ) { // fixed
            surchargeInfo = with_currency(rounded(surcharge.price))
        } else if (surcharge.price_type == 1) { // per m3
            surchargeInfo = with_currency(rounded(surcharge.price)) + " * " + fmt("{m3_amount}")
        } else if (surcharge.price_type == 2) { // per other unit
            const totalSurchargePrice = surcharge.amount * surcharge.price
            surchargeInfo = with_currency(rounded(surcharge.price)) + " * " + (surcharge.amount ? surcharge.amount : "?") + " " + surcharge.unit_name + " = " + with_currency(rounded(totalSurchargePrice))
        }

        return m('.mt-1.p-0.bg-light.row', { onclick: _e => { vnode.state.id = surcharge.id } },
          m('.col-sm-11.col-md-2',
            m('select', { onchange: e => {
                if (e.target.value == '') {
                    vnode.attrs.ondelete(surcharge)
                } else {
                    surcharge.id = parseInt(e.target.value)
                    // Find out properties and modify display according to it
                    const foundSurcharges = Object.values(vnode.state.list_of_surcharges).filter(x => x.id == surcharge.id)
                    surcharge.name = foundSurcharges[0].name
                    surcharge.unit_name = foundSurcharges[0].unit_name
                    surcharge.price_type = foundSurcharges[0].price_type
                    surcharge.price = foundSurcharges[0].price
                    surcharge._original_record_data = foundSurcharges[0]   // We may need all such data in containing component, e.g. "export_name" in Pump surcharges
                }
                if (vnode.attrs.onchange_callback) {
                    vnode.attrs.onchange_callback(surcharge)
                }
            } }, [
                m('option', { selected: surcharge.id ? 0 : 1 }, ''),
                ...options,
            ]),
          ),

          m('.col-sm-10.col-md-1.ml-1', (surcharge.price_type == 2 ) ? m(InputField, { fmt, value: surcharge.amount, size: 7, number: true, onchange_callback: value => {
            surcharge.amount = value
            if (vnode.attrs.onchange_callback) {
                vnode.attrs.onchange_callback(surcharge)
            }
          } }) : null),
          m('.col-2.text-right.small', surcharge.unit_name ? ("X " + surcharge.unit_name) : null),
          (surcharge.name ? DeleteButton : null),
          (surcharge.name ? m(".italic", surchargeInfo) : null),
        )
    }
}

/* Formatter for one row in Expeditions form - price modifiers area. Used for modifiers and totals */
const PriceModifierRow = {
    view: vnode => {
        return m(".border-bottom.mx-1.py-1.row", [
            // FIXME: do not rely on specific children structure!
            m(".col-3", vnode.children[0]),
            m(".col-3", vnode.children[1]),
            m(".col-6", vnode.children[2]),
        ])
    }
}

/* Edit row for value modification in Expeditions form. Shows original value and editbox for entering a new one. Attrs:
        onchange_callback .. as name says
        title             .. displayed on very left
        value             .. original value
        modified_value    .. modified value (used in EditOrder: price was already modified)
        symbol            .. symbol to use after value. If not set, currency_symbol is used
*/
const ValueModifier = {
    view: vnode => {
        const fmt = vnode.attrs.fmt
        const symbol = vnode.attrs.symbol ? vnode.attrs.symbol : global_currency_symbol()
        const valueString = vnode.attrs.value ? (vnode.attrs.value + " " + symbol) : ""
        return m(PriceModifierRow,
            vnode.attrs.title,
            valueString,
            m(InputField, {
              value: vnode.attrs.modified_value,
              number: true,
              fmt,
              placeholder: fmt("{corrected_value_placeholder}"),
              onchange_callback: x => {
                if(vnode.attrs.onchange_callback) {
                    vnode.attrs.onchange_callback((x == null ) ? null : Number(x))
                }
              }
            })
        )
    }
}

const TransportModifier = {
  onchange: vnode => {
    if (vnode.attrs.onchange) {
        vnode.attrs.onchange()
    }
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt

    const distanceModifier = m(ValueModifier, {
      value: modelTransport.distance,
      modified_value: modelTransport.distanceDrivenModified,
      fmt,
      title: fmt('{distance_driven}'),
      symbol: "km",
      onchange_callback: x => {
        modelTransport.distanceDrivenModified = x
        modelTransport.reload_zones()
        TransportModifier.onchange(vnode)
      },
    })

    const transportZoneModifier = modelTransport.zonesLoaded
        ? m(PriceModifierRow, [
            fmt('{transport_zone}'),
            null,
            m(SimpleSelectBox, {
              value: modelTransport.preferred_zone,
              options: modelTransport.zonesAsOptions(),
              empty_option: true,
              onchange_callback: x => {
                modelTransport.set_transport_zone(x)
                TransportModifier.onchange(vnode)
              },
            }),
        ])
        : null
    const transportZoneMinimalAmount = (modelTransport.zone && modelTransport.zone.minimal_volume)
        ? m("div.pl-4.small.italic", fmt("{minimal_volume} ") + modelTransport.zone.minimal_volume + " m³")
        : null
    const pricePerKmModifier = (modelTransport.vehicle && !GlobalConfig.setup.transport_zones)
        ? m(ValueModifier, {
            value: modelTransport.vehicle.price_per_km,
            fmt,
            title: fmt('{price_per_km}'),
            modified_value: modelTransport.preferred_pricePerKm,
            onchange_callback: x => {
                modelTransport.pricePerKmModified = x
                TransportModifier.onchange(vnode)
            },
        })
        : null

    return m("",
        distanceModifier,
        pricePerKmModifier,
        transportZoneModifier,
        transportZoneMinimalAmount
    )

  }
}

/* TODO REF QUE this entire architecture is wrong - get input data for expedition in one request to the backend - with all select box options etc. Discuss, not clear:
        - reworking this such way means alot of work on backend, breaking up architecture with universal endpoints
        - there is absolutely no need for reducing number of requests, app is not time-critical
        - conflicts with another issue above ("move all the calculations to backend"), which would increase number of request significantly.
    This is imho a non-issue: expensive change, adding no value for the user.
    Anyway, big part of (repeated) code in 'oninit' will be moved from this Component to Model,
    as a part of other refactoring issues.
*/
const Expeditions = {
  oninit: vnode => {
    console.debug("Expeditions.oninit", vnode)
    vnode.state.data =  {}
    vnode.state.loaded = false
    Expeditions.load_temperature(vnode)

    // Get cars, transform it to structure that can be used in SmartSelectBox
    vnode.state.cars = {}
    m.request({ url: 'select/Car' }).then(data => {
      vnode.state.cars = nonHiddenRecordsToNamesObject(data.data, x =>
        x.registration_number
        + " "
        + (x._transport_type_name ? (" (" + x._transport_type_name + ")") : "")
      )
    }).catch(err => {
      if (err.code === 401) {
        m.route.set("/login")
      }
    })

    // Ditto for customers, construction sites, contracts and recipes
    vnode.state.customers = {}
    m.request({ url: 'select/Customer' }).then(data => {
        Expeditions.customer_list = data.data
        vnode.state.customers = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    }).catch(err => {
      if (err.code === 401) {
        m.route.set("/login")
      }
    })
    vnode.state.construction_sites = {}
    m.request({ url: 'select/ConstructionSite' }).then(data => {
      vnode.state.construction_sites = nonHiddenRecordsToNamesObject(data.data, x =>
        x.name + " (" + (x.distance ? x.distance : "?") + " km)"
      )
    }).catch(err => {
      if (err.code === 401) {
        m.route.set("/login")
      }
    })
    vnode.state.contracts = {}
    m.request({ url: 'select/Contract' }).then(data => {
        Expeditions.contract_list = data.data
        vnode.state.contracts = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    }).catch(err => {
      if (err.code === 401) {
        m.route.set("/login")
      }
    })
    vnode.state.recipes = {}
    m.request({ url: 'nonempty_recipes' }).then(data => {
      vnode.state.recipes = nonHiddenRecordsToNamesObject(data.data, x =>
        (x.number ? (x.number + ': ') : '')
        + x.name
        + (x.description ? (' (' + x.description + ')') : '')
        + (x.price ? (", " + with_currency(x.price) + " / m³") : "")
      )
    }).catch(err => {
      if (err.code === 401) {
        m.route.set("/login")
      }
    })
    m.request({ url: 'select/CompanySurcharge' }).then(data => {
        vnode.state.company_surcharges = data.data
    }).catch(err => {
      if (err.code === 401) {
        m.route.set("/login")
      }
    })
    vnode.state.doPrintDeliverySheet = true
  },

  load_temperature: vnode => {
    modelOrder.temperature = null
    m.request({ url: 'temperatures' }).then(data => {
      modelOrder.temperature = data["thermometer"]
        ? data["thermometer"].toFixed(1)
        : (data["user"]
          ? data["user"].toFixed(1)
          : 20)
      vnode.state.loaded = true
    }).catch(err => {
      if (err.code === 401) {
        m.route.set("/login")
      }
    })
  },

  /* Called after click on 'duplicate' icon in order list
     Warning: calling_vnode belongs to calling component (order list), not to Expeditions component!
  */
  duplicate_order: (calling_vnode, order) => {
    modelOrder.set_recipe_id(order.recipe_record)
    modelOrder.without_water = order.without_water   // TODO BUG checkbox does not reflect this properly
    modelOrder.customer_id = order.customer_record
    modelOrder.contract_id = order.contract_record
    modelOrder.volume = order.volume
    modelOrder.construction_site_id = order.construction_site_record
    modelOrder.comment = order.comment || ""
    modelOrder.temperature = order.temperature
    modelTransport.reloadVehicle(order.vehicle_record)
    modelOrder.payment_type = order.payment_type
  },

  on_recipe_change: (vnode, RecipeId) => {
    // Recipe was changed. Find out if there is time to take sample, and display warning
    modelOrder.set_recipe_id(RecipeId)
    modelOrder.reloadConcretePrice()

    if(RecipeId && !isNaN(RecipeId)) {
        m.request({ url: 'sample/take/' + RecipeId }).then(response => {
          vnode.state.sampleWarning = (response && GlobalConfig.setup.module_samples) ? vnode.attrs.fmt('{Please take production sample for lab.}') : null
        })
        m.request({url: "detail/Recipe/"+ RecipeId}).then(data => { vnode.state.recipe = data })
    }
  },

  on_customer_change: (vnode, customerId, payment_formfield) => {
    modelOrder.customer_id = customerId
    modelOrder.reloadConcretePrice()
    // Display note and payment info about selected customer
    const customer = recordById(customerId, Expeditions.customer_list)
    vnode.state.customerWarning = customer ? customer.comment : null
    modelOrder.payment_type = customer ? customer.payment_type : null
    payment_formfield.state.value = customer ? customer.payment_type : null  // TODO REF get rid of this
  },

  on_construction_site_change: (_vnode, id) => {
    modelOrder.construction_site_id = id
    modelOrder.reloadConcretePrice()
    m.request({url: "detail/ConstructionSite/"+ id}).then(data => {
        modelTransport.change_distance(data.distance * distance_factor())
    })
  },

  view: vnode => {
    console.debug("Expeditions.view", vnode)
    const fmt = vnode.attrs.fmt

    // Build up form fields.
    let form_fields = {}  // FIXME: this should probably be a list (array)
    if (GlobalConfig.setup.module_contracts) {
      form_fields.contract_id = m(SmartSelectBox, {
        fmt,
        value: modelOrder.contract_id,
        options: vnode.state.contracts,
        onchange_callback: id => {
            modelOrder.contract_id = id
            const contract = recordById(id, Expeditions.contract_list)
            let customer_id = null
            if (contract) {
              customer_id = contract.customer
              modelOrder.volume = contract.default_volume
              Expeditions.on_recipe_change(vnode, contract.recipe)
              Expeditions.on_construction_site_change(vnode, contract.construction_site)
              modelTransport.reloadVehicle(contract.vehicle)
            }
            Expeditions.on_customer_change(vnode, customer_id, form_fields.payment_type)
        },
        title: fmt('{Contract}'),
        autofocus: true
      }, m(ButtonAdd, {
          href: '/contract_open',
          small: true,
      }))
    }
    form_fields.recipe_id = m(SmartSelectBox, {
      fmt,
      value: modelOrder.recipe_id || "",
      options: vnode.state.recipes,
      title: fmt('{recipe}'),
      onchange_callback: id => { Expeditions.on_recipe_change(vnode, id) },
      required: true,
      autofocus: !GlobalConfig.setup.module_contracts,
    })

    form_fields.without_water = m(CheckBox, {
        value: modelOrder.without_water,
        onchange_callback: x => { modelOrder.without_water = x },
    }, fmt('{Without water}'))

    form_fields.volume = m(InputField, {
      value: modelOrder.volume,
      number: true,
      required: true,
      fmt,
      title: fmt('{volume}'),
      onchange_callback: value => { modelOrder.volume = value },
    })

    if (GlobalConfig.setup.module_contracts) {
      form_fields.customer_id = m(SmartSelectBox, {
        fmt,
        value: modelOrder.customer_id,
        options: vnode.state.customers,
        title: fmt('{customer}'),
        onchange_callback: id => { Expeditions.on_customer_change(vnode, id, form_fields.payment_type) },
      }, m(ButtonAdd, { href: '/customer_open', small: true }))
    } else {
      form_fields.customer = m(InputField, {
        fmt,
        title: fmt('{customer}'),
        onchange_callback: value => { modelOrder.customer_name = value },
      })
    }

    if (GlobalConfig.setup.module_cars) {
      form_fields.car = m(SmartSelectBox, {
        fmt,
        value: modelTransport.vehicle_id,
        required: true,
        options: vnode.state.cars,
        title: fmt('{vehicle}'),
        onchange_callback: id => { modelTransport.reloadVehicle(id) },
      }, m(ButtonAdd, {
        href: '/vehicle_open',
        small: true,
      }))
    } else {
      form_fields.vehicle_id = m(InputField, {
        required: true,
        fmt,
        title: fmt('{Vehicle Identification Number}'),
        onchange_callback: value => { modelTransport.vehicle_identification_number = value },
      })
    }

    if (GlobalConfig.setup.module_contracts) {
      form_fields.site_id = m(SmartSelectBox, {
        fmt,
        value: modelOrder.construction_site_id,
        options: vnode.state.construction_sites,
        title: fmt('{construction_site}'),
        onchange_callback: id => { Expeditions.on_construction_site_change(vnode, id) },
      }, m(ButtonAdd, { href: '/site_open', small: true }))
    } else {
      form_fields.construction_site = m(InputField, {
        fmt,
        title: fmt('{construction_site}'),
        onchange_callback: value => { modelOrder.construction_site_name = value },
      })
    }

    form_fields.temperature = m(InputField, {
      value: modelOrder.temperature,
      number: true,
      fmt,
      title: fmt('{temp_air}'),
      onchange_callback: x => { modelOrder.temperature = x },
    })

    form_fields.comment = m(InputField, {
        full_width: true,
        value: modelOrder.comment,
        title: fmt('{comment}'),
        onchange_callback: x => { modelOrder.comment = x },
    })

    if (GlobalConfig.setup.module_contracts) {
      form_fields.payment_type = m(PaymentType, {
        value: modelOrder.payment_type,
        fmt,
        title: fmt("{Payment}"),
        onchange_callback: x => { modelOrder.payment_type = x }
      } )
    }

    const surchargeRows = modelOrder.surcharges.map(x => m(Surcharge, {
        fmt, endpoint: 'select/CompanySurcharge', surcharge: x,
        onchange_callback: _x => { modelOrder.addEmptySurcharge() },
        ondelete: x => { modelOrder.deleteSurchargeByName(x.name) },
    }))

    // Prices fields
    const priceModifiers = [
        m(ValueModifier, {
          value: (modelOrder.getPriceConcrete() ? rounded(modelOrder.getPriceConcrete()) : null),
          modified_value: modelOrder.priceConcreteModified,
          fmt,
          title: fmt('{price_concrete}'),
          onchange_callback: x => { modelOrder.priceConcreteModified = x },
        }),
        m(ValueModifier, {
          value: (modelOrder.getPriceShipping() ? rounded(modelOrder.getPriceShipping()) : null),
          modified_value: modelOrder.priceShippingModified,
          fmt,
          title: fmt('{price_shipping}'),
          onchange_callback: x => { modelOrder.priceShippingModified = x },
        }),
        m(ValueModifier, {
          value: (modelOrder.getPriceSurcharges() ? rounded(modelOrder.getPriceSurcharges()) : null),
          modified_value: modelOrder.priceSurchargesModified,
          fmt,
          title: fmt('{price_services}'),
          onchange_callback: x => { modelOrder.priceSurchargesModified = x },
        }),
    ]

    const modifiedPriceStyle = modelOrder.getPriceTotalModified() < modelOrder.getPriceTotal() ? ".text-danger" : ".text-success"

    // additional info, if customer's concrete price differs from the listed
    const concretePriceInfo = modelOrder.isSpecialPrice() ? (fmt("{price_modified_for_customer}") + " " + with_currency(modelOrder.concrete_price) + " / m³") : null

    return m(Layout, { fmt }, [
      // Form
      m(".row.mt-3",
        // Left column
        m(".col-6.border-right.pr-0", (vnode.state.loaded ? formFieldsToLayout(form_fields) : null)),

        // Right column
        (GlobalConfig.setup.module_prices
            ? m(".col-6",
                // Surcharges area
                ((isMididisp() && vnode.state.company_surcharges && vnode.state.company_surcharges.length) ? [ m(".bold", fmt("{surcharges}:")), ...surchargeRows, ] : null ),

                // Transport area
                (GlobalConfig.setup.module_cars ? m(".bold.mt-2", fmt("{transport}:")) : null),
                (GlobalConfig.setup.module_cars ? m(TransportModifier, {fmt}) : null),

                // Price modifiers area
                m(".bold.mt-2", fmt("{prices}:")),
                (isMididisp() ? priceModifiers[0] : null),
                (isMididisp() ? (concretePriceInfo ? m(".italic.pl-4.small", concretePriceInfo) : null) : null),
                (isMididisp() ? priceModifiers[1] : null),
                (isMididisp() ? priceModifiers[2] : null),

                // Total prices, without and with vat
                m(PriceModifierRow,
                    m(".bold", fmt("{total}:")),
                    modelOrder.getPriceTotal() ? m(".bold", with_currency(rounded(modelOrder.getPriceTotal()))) : null,
                    (isMididisp() ? (modelOrder.getPriceTotalModified() ? m(".bold" + modifiedPriceStyle, with_currency(rounded(modelOrder.getPriceTotalModified())) ) : null) : null),
                ),
                (isMididisp() && GlobalConfig.setup_user && GlobalConfig.setup_user.vat_rate) ?
                    m(PriceModifierRow,
                        m(".bold", fmt("{price_with_vat}:")),
                        modelOrder.getPriceTotal() ? m(".bold", with_currency(rounded(with_vat(modelOrder.getPriceTotal())))) : null,
                        modelOrder.getPriceTotalModified() ? m(".bold" + modifiedPriceStyle, with_currency(rounded(with_vat(modelOrder.getPriceTotalModified())))) : null,
                    ) : null
            )
            : null
        ),
      ),
      (GlobalConfig.setup.module_delivery_sheets ?
          m(".text-right.mt2", [
            m(CheckBox, {
              value: vnode.state.doPrintDeliverySheet,
              onchange_callback: value => { vnode.state.doPrintDeliverySheet = value },
            }, fmt("{print_delivery_sheet}")),
          ]) : null
      ),
      m('.text-right.mt-2',
        m(".btn.btn-secondary.px-4.mr-2", {  // Clear form button
          onclick: _e => {
            modelTransport.reset()
            modelOrder.reset()
            vnode.state.sampleWarning = null
            vnode.state.customerWarning = null
          }
        }, fmt('{clean_up_form}')),
        // Submit button below entire table
        m(m.route.Link, {
          class: 'btn btn-primary px-4',
          href: '/expeditions',
          options: { replace: true },
          onclick: _e => {
            // Gather all data to be send to endpoint
            const dataToSend = {
                volume: modelOrder.volume,
                without_water: modelOrder.without_water,
                comment: modelOrder.comment,
                customer_id: modelOrder.customer_id,
                custome: modelOrder.customer_name,  // used when module_contracts is off,
                contract_id: modelOrder.contract_id,
                recipe_id: modelOrder.recipe_id,
                site_id: modelOrder.construction_site_id,
                construction_site: modelOrder.construction_site_name,  // used when module_contracts is off,
                car: modelTransport.vehicle_id,
                vehicle_id: modelTransport.vehicle_identification_number,  // Used when module_cars is off,
                temperature: modelOrder.temperature,
                payment_type: modelOrder.payment_type,
                surcharges: modelOrder.surcharges,
                price_concrete_modified: modelOrder.priceConcreteModified,
                price_transport_modified: modelOrder.priceShippingModified,
                price_surcharges_modified: modelOrder.priceSurchargesModified,
                distance_driven_modified: modelTransport.distanceDrivenModified,
                price_per_km_modified: modelTransport.pricePerKmModified,
                transport_zone: modelTransport.zone,
            }

            m.request({ url: 'produce', method: 'POST', body: dataToSend }).then(data => {
              const takeSample = !!(vnode.state.sampleWarning && GlobalConfig.setup.module_samples)
              ServerMessages.set(data)
              // Post-order actions: clean up form and redraw orders
              if (!data.error) {
                  Expeditions.load_temperature(vnode)
                  const last_used_recipe_id = modelOrder.recipe_id
                  modelTransport.reset()
                  modelOrder.reset()
                  vnode.state.sampleWarning = null
                  vnode.state.customerWarning = null
                  m.route.set(takeSample ? ('/sample_msgbox/' + last_used_recipe_id) : '/expeditions')

                  if (vnode.state.doPrintDeliverySheet && data.delivery_id) {
                    // TODO REF: this is being blocked by browser popup blocker - so i'm using the iframe trick for now...
                    //window.open("print/delivery_sheet/"+data.delivery_id, "_blank")
                    url = "print/delivery_sheet/" + data.delivery_id + "?lang=" + vnode.attrs.lang
                    console.debug("Expeditions: setting toPrint", url)
                    vnode.state.toPrint = url
                  }
              }
            })
          }
        }, fmt('{Send_to_production}'))
      ),
      // Warnings area
      m(InfoBox, {level: "warning", text: vnode.state.customerWarning}),
      m(InfoBox, {level: "error", text: vnode.state.sampleWarning}),
      // Table with orders
      m('.mt-3', listOfOrders(vnode, "get_archive", true)),
      // TODO REF: this used the iframe trick - find a cleaner way
      vnode.state.toPrint
        ? m("iframe", {
            src: vnode.state.toPrint,
            width: 1,
            height: 1,
            onload: () => {
                console.debug("Expeditions: resetting toPrint")
                vnode.state.toPrint = null
            },
        })
        : null,
    ])
  }
}

const OpenOrder = {
  /* List of batches, actually */
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView, {
      fmt,
      model_name: 'Batch',
      select_endpoint: 'batches/' + vnode.attrs.id,
      delete_disabled: true,
      display_columns: ['volume', 'batch_number', 'batch_count', 'production_start_human', 'production_end_human', 'mixing_duration', 'consistency', 'additional_water']
    })
    return m(ListLayout, {fmt}, myList)
  }
}

/* Edits some order attributes. Attrs:
     id .. id of order
*/
const EditOrder = {
  oninit: vnode => {
      m.request("detail/Order/" + vnode.attrs.id).then(data => {
        vnode.state.order = data
        vnode.state.order.surcharges.push({})
        modelTransport.reset()
        modelOrder.reset()
        modelTransport.preferred_zone = data.transport_zone_modified
        modelTransport.preferred_pricePerKm = data.price_per_km_modified
        modelTransport.change_distance(data.distance_driven_modified)
        modelTransport.reloadVehicle(data.vehicle_record)
      })

      vnode.state.data = {}

      m.request({ url: 'select/Delivery' }).then(data => {
          // find id of 1st delivery corresponding to this order. Order can have multiple deliveries, but in current workflow only 1st delivery is used.
          const deliveries = data.data.filter( record => { return record.order == vnode.attrs.id})
          vnode.state.delivery_id = deliveries[0].id
          m.request({ url: 'detail/Delivery/' + vnode.state.delivery_id }).then(data => {
            vnode.state.data = data

            // If dates are not set, use current date and time
            for (const valueName of ["construction_site_arrival_t", "unload_start_t", "unload_end_t"]) {
                if (!vnode.state.data[valueName]) {
                    vnode.state.data[valueName] = new Date()  // TODO: this is not timestamp
                }
            }
            // And transform it to proper text representation, which can be handled by standard InputField
            const mydate = t => new Date(t * 1000)
            // TODO REF: why the .site_arrival and .construction_site_arrival duality?
            vnode.state.data.site_arrival_date = std_date_format(mydate(vnode.state.data.construction_site_arrival_t))
            vnode.state.data.site_arrival_time = std_time_format(mydate(vnode.state.data.construction_site_arrival_t))
            vnode.state.data.unload_start_date = std_date_format(mydate(vnode.state.data.unload_start_t))
            vnode.state.data.unload_start_time = std_time_format(mydate(vnode.state.data.unload_start_t))
            vnode.state.data.unload_end_date = std_date_format(mydate(vnode.state.data.unload_end_t))
            vnode.state.data.unload_end_time = std_time_format(mydate(vnode.state.data.unload_end_t))

          })
      })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        site_arrival_date: m(InputField, {
            value: vnode.state.data.site_arrival_date,
            placeholder: fmt("{date_placeholder}"),
            fmt,
            title: fmt('{date_site_arrival}'),
            onchange_callback: x => { vnode.state.data.site_arrival_date = x },
        }),
        site_arrival_time: m(InputField, {
            value: vnode.state.data.site_arrival_time,
            placeholder: fmt("{time_placeholder}"),
            fmt,
            title: fmt('{time_site_arrival}'),
            onchange_callback: x => { vnode.state.data.site_arrival_time = x },
        }),
        unload_start_date: m(InputField, {
            value: vnode.state.data.unload_start_date,
            placeholder: fmt("{date_placeholder}"),
            fmt,
            title: fmt('{date_unloading_start}'),
            onchange_callback: x => { vnode.state.data.unload_start_date = x },
        }),
        unload_start_time: m(InputField, {
            value: vnode.state.data.unload_start_time,
            placeholder: fmt("{time_placeholder}"),
            fmt,
            title: fmt('{time_unloading_start}'),
            onchange_callback: x => { vnode.state.data.unload_start_time = x },
        }),
        unload_end_date: m(InputField, {
            value: vnode.state.data.unload_end_date,
            placeholder: fmt("{date_placeholder}"),
            fmt,
            title: fmt('{date_unloading_end}'),
            onchange_callback: x => { vnode.state.data.unload_end_date = x },
        }),
        unload_end_time: m(InputField, {
            value: vnode.state.data.unload_end_time,
            placeholder: fmt("{time_placeholder}"),
            fmt,
            title: fmt('{time_unloading_end}'),
            onchange_callback: x => { vnode.state.data.unload_end_time = x },
        }),
    } : {}

    const surchargeRows = vnode.state.order ? vnode.state.order.surcharges.map(x => m(FormRow, {}, m(''), m(Surcharge, {
        surcharge: x,
        endpoint: 'select/CompanySurcharge',
        onchange_callback: _x => {
            // Add empty surcharge if there are no empty slots
            const emptySurcharges = vnode.state.order.surcharges.filter(x => !x.name)
            if (!emptySurcharges.length) {
                vnode.state.order.surcharges.push({})
            }
        },
        ondelete: x => {
            let index = null
            for (let i = 0; i < vnode.state.order.surcharges.length; i++) {
                if (vnode.state.order.surcharges[i].name == x.name) {
                    index = i
                }
            }
            vnode.state.order.surcharges.splice(index, 1)
        },
    }))) : []

    // Transport can be modified only for orders paid by invoice
    const isInvoice = (vnode.state.order && (vnode.state.order.payment_type == 1))
    const transportModifierArea = isInvoice ? m(TransportModifier, {fmt}) : null
    const transportModifierHeader = isInvoice ? m(FormSubHeader, fmt("{transport}:")) : null

    // Price modification fields
    const o = vnode.state.order // just shorthand
    const priceModifierTransport = ( vnode.state.order && !vnode.state.order.without_transport ) ?
        m(ValueModifier, {
          value: (o.price_transport_calculated ? o.price_transport_calculated.toFixed(0) : null),
          modified_value: (o.price_transport_modified ? o.price_transport_modified.toFixed(0) : null),
          fmt,
          title: fmt('{price_shipping}'),
          onchange_callback: x => { vnode.state.order.price_transport_modified = x },
        }) : m(".py-2.px-3.border-bottom.italic", fmt("{order_without_transport}"))
    const priceModifiers = vnode.state.order ? [
        m(ValueModifier, {
          value: (o.price_concrete_calculated ? o.price_concrete_calculated.toFixed(0) : null),
          modified_value: (o.price_concrete_modified ? o.price_concrete_modified.toFixed(0) : null),
          fmt,
          title: fmt('{price_concrete}'),
          onchange_callback: x => { vnode.state.order.price_concrete_modified = x },
        }),
        priceModifierTransport,
        m(ValueModifier, {
          value: (o.price_surcharges_calculated ? o.price_surcharges_calculated.toFixed(0) : null),
          modified_value: (o.price_surcharges_modified ? o.price_surcharges_modified.toFixed(0) : null),
          fmt,
          title: fmt('{price_services}'),
          onchange_callback: x => { vnode.state.order.price_surcharges_modified = x },
        }),
    ] : null

    // Some details about order, just shown, no edit
    const infoArea = vnode.state.order ? [
        m(FormRow, fmt("{volume}") + ": ", vnode.state.order.volume.toFixed(1) + ' m³'),
        m(FormRow, fmt("{recipe}") + ": ", vnode.state.order.r_name),
        m(FormRow, fmt("{customer}") + ": ", vnode.state.order.customer),
    ] : null

    return m(Layout, { fmt },
      m('.mt-4'),
      (vnode.state.order ? m(FormHeader, fmt("{edit_order} ") + vnode.state.order.auto_number) : null),
      infoArea,
      formFieldsToLayout(fields),
      (isMididisp() ? [ m(FormSubHeader, fmt("{surcharges}") + ":"), ...surchargeRows, ] : null ),
      m('.mt-4'),
      transportModifierHeader,
      transportModifierArea,
      m(FormSubHeader, fmt("{prices}:")),
      priceModifiers,
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => {
        const dataToSent = { ...DataFromFormFields(fields), order: vnode.state.order }
        if (isInvoice) {
            dataToSent.order.distance_driven_modified = modelTransport.get_distance()
            dataToSent.order.price_per_km_modified = modelTransport.pricePerKmModified
            dataToSent.transport_zone = modelTransport.zone
        } else {
            // Slight HACK: not sending entire TransportZone structure, but only ID.
            // It is OK as long as backend uses only ID part of this record
            dataToSent.transport_zone = vnode.state.order.transport_zone_modified ? { id: vnode.state.order.transport_zone_modified } : null
        }
        MyPostRequest('update_order/' + vnode.state.delivery_id, dataToSent, "/orders")
      }})
    )
  }
}

const Orders = {
  view: vnode => {
    console.debug("Orders.view", vnode)
    return m(ListLayout, {fmt: vnode.attrs.fmt, hideable: true}, listOfOrders(vnode))
  }
}

const StockMovements = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView, {
      fmt,
      delete_disabled: true,
      select_endpoint: '/stock_movements/' + vnode.attrs.id,
      display_columns: ['t_human', 'amount', 'comment']
    })
    return m(ListLayout, {fmt}, myList)
  }
}

const OpenMaterial = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/Material/' + vnode.attrs.id }).then(data => { vnode.state.data = data })
    } else {
      vnode.state.data = {
        type: 'Aggregate', // TODO REF NTH find better way to set default type
        name: null,
        long_name: null,
        unit: null,
        comment: null
      }
    }
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        type: m(SimpleSelectBox, {
          value: vnode.state.data.type,
          options: {
            Aggregate: fmt('{Aggregate}'),
            Addition: fmt('{Addition}'),
            Cement: fmt('{Cement}'),
            Water: fmt('{Water}'),
            Admixture: fmt('{Admixture}')
          },
          title: fmt('{type}') }),
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{name}'),
            onchange_callback: x => { vnode.state.data.name = x },
        }),
        long_name: m(InputField, {
            value: vnode.state.data.long_name,
            fmt, title: fmt('{long_name}'),
            onchange_callback: x => { vnode.state.data.long_name = x },
        }),
        unit: m(InputField, {
            value: vnode.state.data.unit,
            fmt,
            title: fmt('{unit}'),
            onchange_callback: x => { vnode.state.data.unit = x },
        }),
        comment: m(InputField, {
            value: vnode.state.data.comment,
            full_width: true,
            fmt,
            title: fmt('{Note}'),
            onchange_callback: x => { vnode.state.data.comment = x },
        })
    } : {}

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => { MyPostRequest(
            (vnode.attrs.id != null) ? 'update_material/' + vnode.attrs.id : 'add/Material',
            DataFromFormFields(fields),
            "/materials"
      )}})
    )
  }
}

const Materials = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = "Material"

    const myList = m(ListView, {
      fmt,
      model_name,
      detail_url: '/material_open/',
      display_columns: ['name', "type_str", 'unit', 'long_name', 'comment'],
      columnNames: {"type_str": "{type}"},
      actions: GlobalConfig.setup.module_stock ? [{ icon: 'fas.fa-layer-group.pointer', name: fmt('{Stock movements}'), url: '/material/stock_movements/:id' }] : null,
    })

    return m(ListLayout, {fmt, add_url: userLocks.isLocked(model_name) ? null : '/material_open/'}, myList)
  }
}

/* Edit row for one recipe material, used in OpenRecipe. Attrs:
        material .. material to be edited
        ondelete .. MANDATORY called back when material is deleted, with 'to be deleted' material as parameter
        onadd     .. called back when user needs to add new material (e.g. when selects 'something' from 1st selectbox)
*/
const RecipeMaterial = {
    oninit: vnode => {
        vnode.state.material_types = {}
        m.request({ url: 'materials_types_get' }).then(material_types => { vnode.state.material_types = material_types })
    },

    // returns true if material is of type 'addition'
    is_addition: (vnode, material) => {
      if(vnode.state.material_types.Addition) {
          const additionIds = vnode.state.material_types.Addition.map(item => { return item.id })
          return (additionIds.indexOf(material.material) != -1)
      }
    },

    view: vnode => {
        const material = vnode.attrs.material
        const fmt = vnode.attrs.fmt
        const material_types = vnode.state.material_types ? vnode.state.material_types : {}
        const newRow = (material.material === undefined)

        const DeleteButton = newRow
          ? m('')
          : m('.col-1.text-right.fas.fa-trash.text-danger', { onclick: _e => { vnode.attrs.ondelete(material); } }, '')

        const kFieldsDisabled = !RecipeMaterial.is_addition(vnode, material)
        const kValueField = m(InputField, {
            fmt,
            value: material.k_value,
            size: 7,
            number: true,
            disabled: kFieldsDisabled,
            onchange_callback: value => { material.k_value = value },
        })
        const kRatioField = m(InputField, {
            fmt,
            value: material.k_ratio,
            size: 7,
            number: true,
            disabled: kFieldsDisabled,
            onchange_callback: value => { material.k_ratio = value },
        })
        const amountField = m(InputField, {
            fmt,
            value: material.amount,
            size: 7,
            number: true,
            onchange_callback: value => { material.amount = value },
        })
        const delayField = m(InputField, {
            fmt,
            value: material.delay,
            size: 7,
            number: true,
            onchange_callback: value => { material.delay = value },
        })

        return m('.mx-4.mt-1.p-1.bg-light.row', { onclick: _e => { vnode.state.id = material.id } }, [
          // Material selector
          m('.col-sm-11.col-md-2',
            m('select', {
              onchange: e => {
                material.material = parseInt(e.target.value)
                const kFieldsDisabled = !RecipeMaterial.is_addition(vnode, material)
                kValueField.state.disabled = kFieldsDisabled
                kRatioField.state.disabled = kFieldsDisabled
                if (newRow) {
                    vnode.attrs.onadd(material)
                }
              }
            },
            m('option', { selected: material.material ? 0 : 1 }, ''),
            m('optgroup', { label: fmt('{Aggregate}') },
              material_types.Aggregate ? material_types.Aggregate.map(x => m('option', { value: x.id, selected: x.id === material.material ? 1 : 0 }, x.name)) : []
            ),
            m('optgroup', { label: fmt('{Cement}') },
              material_types.Cement ? material_types.Cement.map(x => m('option', { value: x.id, selected: x.id === material.material ? 1 : 0 }, x.name)) : []
            ),
            m('optgroup', { label: fmt('{Water}') },
              material_types.Water ? material_types.Water.map(x => m('option', { value: x.id, selected: x.id === material.material ? 1 : 0 }, x.name)) : []
            ),
            m('optgroup', { label: fmt('{Admixture}') },
              material_types.Admixture ? material_types.Admixture.map(x => m('option', { value: x.id, selected: x.id === material.material ? 1 : 0 }, x.name)) : []
            ),
            m('optgroup', { label: fmt('{Addition}') },
              material_types.Addition ? material_types.Addition.map(x => m('option', { value: x.id, selected: x.id === material.material ? 1 : 0 }, x.name)) : []
            )
            )),

          // Properties
          m('.col-1.text-right.small', fmt('{amount}:')),
          m('.col-sm-10.col-md-1', amountField),
          m('.col-1.text-right.small', fmt('{Delay}:')),
          m('.col-sm-10.col-md-1', delayField),
          m('.col-1.text-right.small', fmt('{K-value}:')),
          m('.col-sm-10.col-md-1', kValueField),
          m('.col-1.text-right.small', fmt('{K-ratio}:')),
          m('.col-sm-10.col-md-1', kRatioField),

          (userLocks.isLocked("Recipe") ? null : DeleteButton),
        ])
    }
}


const OpenRecipe = {
  oninit: vnode => {
    vnode.state.materials = []
    vnode.state.data = {}
    vnode.state.loaded_count = 0  // how many data sets is loaded - TODO: get rid of this
    //m.request({ url: 'linked_materials/' + (vnode.attrs.id ? vnode.attrs.id : 0) }).then(data => { vnode.state._materials = data; vnode.state.loaded_count += 1 })
    m.request({ url: 'select/Defaults' })
    .then(data => {
        vnode.state.defaults = data
        vnode.state.loaded_count += 1
    })
    if (vnode.attrs.action || (vnode.attrs.id != null)) {
      m.request({ url: 'detail/Recipe/' + vnode.attrs.id })
      .then(data => {
          vnode.state.data = data
          vnode.state._materials = data._materials
          vnode.state.loaded_count += 1
      })
    } else {
      vnode.state.data = {
        lift_semi_pour_duration: 0,
        consistency_class: '',
        k_ratio: 0,
        k_value: 0,
        batch_volume_limit: 0,
        mixing_duration: 0,
        mixer_opening_duration: 0,
        mixer_semi_opening_duration: 0,
        mixer_semi_opening2_duration: 0,
        lift_pour_duration: 0,
        _materials: [],
        _production: []
      }
      vnode.state.loaded_count += 1
    }
  },

  // TODO REF: get rid of this
  doubleRow: items => {
    return m('.row.mx-4', items)
  },

  // TODO REF: ugly
  oneRow: (field, name, required) => {
    return m('.col-sm-12.col-md-6', [
        m(FormRow, [
            m("span" + (required ? '.bold' : ''), name ? (name + ':') : ''),
            field,
        ]),
    ])
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    vnode.state._materials = vnode.state._materials ? vnode.state._materials : []
    let fields = {}
    let sampleInfo = ''

    if (Object.keys(vnode.state.data).length > 0) {
      fields = {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            onchange_callback: value => { vnode.state.data.name = value },
        }),
        recipe_class: m(InputField, {
            value: vnode.state.data.recipe_class,
            fmt,
            onchange_callback: value => { vnode.state.data.recipe_class = value },
        }),
        description: m(InputField, {
            value: vnode.state.data.description,
            fmt,
            onchange_callback: value => { vnode.state.data.description = value },
        }),
        k_ratio: m(InputField, {
            number: true,
            value: vnode.state.data.k_ratio,
            fmt,
            onchange_callback: value => { vnode.state.data.k_ratio = value },
        }),
        k_value: m(InputField, {
            number: true,
            value: vnode.state.data.k_value,
            fmt,
            onchange_callback: value => { vnode.state.data.k_value = value },
        }),
        consistency_class: m(InputField, {
            value: vnode.state.data.consistency_class,
            fmt,
            onchange_callback: value => { vnode.state.data.consistency_class = value },
        }),
        exposure_classes: m(InputField, {
            value: vnode.state.data.exposure_classes,
            fmt,
            onchange_callback: value => { vnode.state.data.exposure_classes = value },
        }),
        batch_volume_limit: m(InputField, {
            number: true,
            value: vnode.state.data.batch_volume_limit,
            fmt,
            onchange_callback: value => { vnode.state.data.batch_volume_limit = value },
        }),
        mixing_duration: m(InputField, {
            number: true,
            value: vnode.state.data.mixing_duration,
            fmt,
            onchange_callback: value => { vnode.state.data.mixing_duration = value },
        }),
        comment: m(InputField, {
            value: vnode.state.data.comment,
            full_width: true,
            fmt,
            onchange_callback: value => { vnode.state.data.comment = value },
        }),
        mixer_opening_duration: m(InputField, {
            number: true,
            value: vnode.state.data.mixer_opening_duration,
            fmt,
            onchange_callback: value => { vnode.state.data.mixer_opening_duration = value },
        }),
        mixer_semi_opening_duration: m(InputField, {
            number: true,
            value: vnode.state.data.mixer_semi_opening_duration,
            fmt,
            onchange_callback: value => { vnode.state.data.mixer_semi_opening_duration = value },
        }),
        mixer_semi_opening2_duration: m(InputField, {
            number: true,
            value: vnode.state.data.mixer_semi_opening2_duration,
            fmt,
            onchange_callback: value => { vnode.state.data.mixer_semi_opening2_duration = value },
        }),
        lift_semi_pour_duration: m(InputField, {
            number: true,
            value: vnode.state.data.lift_semi_pour_duration,
            fmt,
            onchange_callback: value => { vnode.state.data.lift_semi_pour_duration = value },
        }),
        lift_pour_duration: m(InputField, {
            number: true,
            value: vnode.state.data.lift_pour_duration,
            fmt,
            onchange_callback: value => { vnode.state.data.lift_pour_duration = value },
        }),
        number: m(InputField, {
            value: vnode.state.data.number,
            fmt,
            onchange_callback: value => { vnode.state.data.number = value },
        }),
        d_max: m(InputField, {
            integer: true,
            value: vnode.state.data.d_max,
            fmt,
            onchange_callback: value => { vnode.state.data.d_max = value },
        }),
        cl_content: m(InputField, {
            number: true,
            value: vnode.state.data.cl_content,
            fmt,
            onchange_callback: value => { vnode.state.data.cl_content = value },
        }),
        vc: m(InputField, {
            number: true,
            value: vnode.state.data.vc,
            fmt,
            onchange_callback: value => { vnode.state.data.vc = value },
        }),
        cement_min: m(InputField, {
            number: true,
            value: vnode.state.data.cement_min,
            fmt,
            onchange_callback: value => { vnode.state.data.cement_min = value },
        }),
        workability_time: m(InputField, {
            number: true,
            value: vnode.state.data.workability_time,
            fmt,
            onchange_callback: value => { vnode.state.data.workability_time = value },
        }),
        sample_period_days: m(InputField, {
            value: vnode.state.data._production.sample_period_days,
            number: true,
            fmt,
            onchange_callback: value => { vnode.state.data.sample_period_days = value },
        }),
        sample_period_volume: m(InputField, {
            value: vnode.state.data._production.sample_period_volume,
            number: true,
            fmt,
            onchange_callback: value => { vnode.state.data.sample_period_volume = value },
        }),
        price: m(InputField, {
            number: true,
            value: vnode.state.data.price,
            fmt,
            onchange_callback: value => { vnode.state.data.price = value },
        }),
      }

      sampleInfo = fmt('{Produced %1 m3. Last sample: %2 m3, date: %3}')
        .replace('%1', vnode.state.data._production.volume_total ? vnode.state.data._production.volume_total.toFixed(2) : 0)
        .replace('%2', vnode.state.data._production.sample_last_volume ? vnode.state.data._production.sample_last_volume.toFixed(2) : 0)
        .replace('%3', vnode.state.data._production.sample_last_t ? vnode.state.data._production.sample_last_t_human : fmt('{unknown}'))
    }

    // Build up select box to apply defaults
    let defaults = []
    if (vnode.state.defaults != null) {
      // FIXME: no closure here
      defaults = vnode.state.defaults.data.map(x => {
        const selected = (vnode.state.data.defaults == x.id) ? 1 : 0
        return m('option', { value: x.id, selected }, x.name)
      })
    }
    const EmptyOption = [m('option', { value: null }, '-')]
    const OptionsDefaults = [...EmptyOption, ...defaults]

    const SelectboxDefaults = m('select', { value: vnode.state.data.defaults }, OptionsDefaults)
    const ApplyButton = m('.btn.btn-primary.ml-2.px-2.py-0', {
      onclick: _e => {
        vnode.state.selected_default = null
        vnode.state.defaults.data.forEach((item, _index, _arr) => {
          if (item.id == SelectboxDefaults.dom.value) {
            vnode.state.selected_default = item
          }
        })
        if (vnode.state.selected_default != null) {
            for (const valueName of ['consistency_class', 'k_ratio', 'k_value', 'batch_volume_limit', 'lift_semi_pour_duration', 'mixing_duration', 'mixer_opening_duration', 'mixer_semi_opening_duration', 'mixer_semi_opening2_duration', 'lift_pour_duration', 'workability_time']) {
              if (vnode.state.selected_default[valueName]) {
                vnode.state.data[valueName] = vnode.state.selected_default[valueName]
              }
            }
        }
      }
    }, fmt('{Apply}'))

    const field_defaults = m('',
        SelectboxDefaults,
        (userLocks.isLocked("Recipe") ? null : ApplyButton)
    )

    /* Total weight is just a rough approximation. Assume that one unit of anything weights exactly 1 kg. */
    let totalWeight = 0
    for (const mat of vnode.state._materials) {
      totalWeight += Number(mat.amount)
    }
    totalWeight = isNaN(totalWeight) ? "?" : totalWeight.toFixed(2)

    const mySubmitButton = m('.mr-4.mb-3.text-right.fixed-bottom',
        m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => {
            const toSend = {
              defaults: vnode.state.selected_default ? vnode.state.selected_default.id : null,
              materials: vnode.state._materials,
            }
            for (const key of Object.keys(fields)) {  // Don't use DataFromformFields anymore, See note in that function
                toSend[key] = vnode.state.data[key]
            }
            const endpointUrl = ((vnode.attrs.id == null) || vnode.attrs.action) ? 'recipe_add' : ('recipe_update/' + vnode.attrs.id)
            MyPostRequest(endpointUrl,  toSend, "/recipes")
        }})
    )

    const entireForm = [
      m('.mt-3'),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.number, fmt('{number}'), false),
        OpenRecipe.oneRow(field_defaults, fmt('{Defaults}:'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.name, fmt('{name}'), true),
        OpenRecipe.oneRow(fields.batch_volume_limit, fmt('{Batch volume limit}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.recipe_class, fmt('{strength_class}'), false),
        OpenRecipe.oneRow(fields.consistency_class, fmt('{consistency_class}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.description, fmt('{description}'), false),
        OpenRecipe.oneRow(fields.mixing_duration, fmt('{mixing_duration}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.comment, fmt('{Note}'), false),
        OpenRecipe.oneRow(fields.lift_pour_duration, fmt('{Lift pour duration}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.exposure_classes, fmt('{exposure_classes}'), false),
        OpenRecipe.oneRow(fields.lift_semi_pour_duration, fmt('{Lift semi pour duration}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.d_max, fmt('{D max}'), false),
        OpenRecipe.oneRow(fields.mixer_semi_opening_duration, fmt('{mixer_semi_opening_duration}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.cl_content, fmt('{CL content}'), false),
        OpenRecipe.oneRow(fields.mixer_semi_opening2_duration, fmt('{mixer_semi_opening2_duration}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.vc, fmt('{W/C}'), false),
        OpenRecipe.oneRow(fields.mixer_opening_duration, fmt('{mixer_opening_duration}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.cement_min, fmt('{CementMin}'), false),
        OpenRecipe.oneRow(fields.k_value, fmt('{K-value}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.sample_period_volume, fmt('{Take sample after (m3)}'), false),
        OpenRecipe.oneRow(fields.k_ratio, fmt('{K-ratio}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.sample_period_days, fmt('{Take sample after (days)}'), false),
        OpenRecipe.oneRow(fields.workability_time, fmt('{workability_time}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(fields.price, fmt('{price_per_m3}'), false),
      ]),
      OpenRecipe.doubleRow([
        OpenRecipe.oneRow(m('span.small', sampleInfo), '', false),
      ]),

      m(FormSubHeader, fmt('{Materials (total weight %1 kg)}:').replace('%1', totalWeight)),

      // existing materials rows
      m('', vnode.state._materials.map(material => m(RecipeMaterial, { fmt, material, ondelete: material => {
        // Find and delete material based on material.material value.
        let index = null
        for (let i = 0; i < vnode.state._materials.length; i++) {
            if (vnode.state._materials[i].material.toString() == material.material.toString()) {
                index = i
            }
        }
        vnode.state._materials.splice(index, 1)
      } }))),

      // new material row
      m(RecipeMaterial, {
          fmt,
          onadd: material => { vnode.state._materials.push(material) },
          material: {
              amount: null,
              delay: null,
              MaterialId: null,
              RecipeId: vnode.attrs.id,
          },
      }),

      // naive spacer: submit button sometimes covers last line, so selectbox in new material row is inacessible
      m('.mb-5.pb-5'),

      (userLocks.isLocked("Recipe") ? null : mySubmitButton)
    ]

    return m(Layout, { fmt }, vnode.state.loaded_count == 2 ? entireForm : m(Loading))
  }
}

const Recipes = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = "Recipe"
    const myList = m(ListView, {
      fmt,
      model_name,
      detail_url: '/recipe_open/',
      display_columns: ['number', 'name', 'description', 'consistency_class', 'price'],
      actions: userLocks.isLocked(model_name)
        ? []
        : [{ icon: 'fas.fa-copy.pointer', name: fmt('{Duplicate recipe}'), url: '/recipe_open/:id/copy' }],
    })
    return m(ListLayout, {
      fmt,
      add_url: userLocks.isLocked(model_name) ? null : '/recipe_open/',
      buttons: m('form.py-3', { action: 'export_recipes_csv', method: 'GET', target: '_blank' }, m(ExportButtons, {fmt: vnode.attrs.fmt})),
    }, myList)
  }
}

const OpenDefaults = {
  successUrl: "/defaults",

  oninit: vnode => {
    // When values are updated, the msgbox "Update defaults in recipes" has to be displayed.
    vnode.state.inquiry = false  // Is msgbox displayed?

    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/Defaults/' + vnode.attrs.id }).then(data => { vnode.state.data = data })
    } else {
      vnode.state.data = {
        name: null,
      }
    }
  },

  send_data: (vnode, do_replace) => {
      m.request({
        url: 'update/Defaults/' + vnode.state.data.id,
        method: 'POST',
        body: { do_replace, ...vnode.state.dataToSent },  // FIXME: do not mix actual data and metadata
      }).then((data) => {
        ServerMessages.set(data)
        m.route.set(OpenDefaults.successUrl)
     })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0)
      ? {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{name}'),
            onchange_callback: value => { vnode.state.data.name = value },
        }),
        batch_volume_limit: m(InputField, {
            number: true,
            value: vnode.state.data.batch_volume_limit,
            fmt,
            title: fmt('{Batch volume limit}'),
            onchange_callback: value => { vnode.state.data.batch_volume_limit = value },
        }),
        lift_pour_duration: m(InputField, {
            number: true,
            value: vnode.state.data.lift_pour_duration,
            fmt,
            title: fmt('{Lift pour duration}'),
            onchange_callback: value => { vnode.state.data.lift_pour_duration = value },
        }),
        lift_semi_pour_duration: m(InputField, {
            number: true,
            value: vnode.state.data.lift_semi_pour_duration,
            fmt,
            title: fmt('{Lift semi pour duration}'),
            onchange_callback: value => { vnode.state.data.lift_semi_pour_duration = value },
        }),
        k_value: m(InputField, {
            number: true,
            value: vnode.state.data.k_value,
            fmt,
            title: fmt('{K-value}'),
            onchange_callback: value => { vnode.state.data.k_value = value },
        }),
        k_ratio: m(InputField, {
            number: true,
            value: vnode.state.data.k_ratio,
            fmt,
            title: fmt('{K-ratio}'),
            onchange_callback: value => { vnode.state.data.k_ratio = value },
        }),
        mixing_duration: m(InputField, {
            number: true,
            value: vnode.state.data.mixing_duration,
            fmt,
            title: fmt('{mixing_duration}'),
            onchange_callback: value => { vnode.state.data.mixing_duration = value },
        }),
        mixer_semi_opening_duration: m(InputField, {
            number: true,
            value: vnode.state.data.mixer_semi_opening_duration,
            fmt,
            title: fmt('{mixer_semi_opening_duration}'),
            onchange_callback: value => { vnode.state.data.mixer_semi_opening_duration = value },
        }),
        mixer_semi_opening2_duration: m(InputField, {
            number: true,
            value: vnode.state.data.mixer_semi_opening2_duration,
            fmt,
            title: fmt('{mixer_semi_opening2_duration}'),
            onchange_callback: value => { vnode.state.data.mixer_semi_opening2_duration = value },
        }),
        mixer_opening_duration: m(InputField, {
            number: true,
            value: vnode.state.data.mixer_opening_duration,
            fmt,
            title: fmt('{mixer_opening_duration}'),
            onchange_callback: value => { vnode.state.data.mixer_opening_duration = value },
        }),
        consistency_class: m(InputField, {
            value: vnode.state.data.consistency_class,
            fmt,
            title: fmt('{consistency_class}'),
            onchange_callback: value => { vnode.state.data.consistency_class = value },
        }),
        workability_time: m(InputField, {
            value: vnode.state.data.workability_time,
            fmt,
            title: fmt('{workability_time}'),
            onchange_callback: value => { vnode.state.data.workability_time = value },
        }),
      }
      : {}

    if (vnode.state.inquiry) {
        return m(Msgbox, {
            title: fmt('{update_all_recipes_with_this_default}'),
            buttons: [
              m(StdButton, { text: fmt('{Yes}'), onclick: _e => { OpenDefaults.send_data(vnode, 1) } } ),
              m(StdButton, { text: fmt('{No}'), onclick: _e => { OpenDefaults.send_data(vnode, 0) } } )
            ]
        })
    } else {
        return m(Layout, { fmt },
          m('.mt-4'),
          formFieldsToLayout(fields),
          m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => {
            vnode.state.dataToSent = DataFromFormFields(fields)  // copy to state what has been entered in the form
            if (vnode.attrs.id == null) {
              MyPostRequest('add/Defaults', vnode.state.dataToSent, OpenDefaults.successUrl)
            } else {
              vnode.state.inquiry = true
            }
          }}),
        )
    }
  }
}

const Defaults = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView, {
      fmt,
      model_name: 'Defaults',
      detail_url: '/defaults_open/',
      display_columns: ['name', 'batch_volume_limit', 'mixing_duration', 'mixer_semi_opening_duration', 'mixer_opening_duration', 'consistency_class', 'workability_time']
    })
    return m(ListLayout, {fmt, add_url: '/defaults_open/'}, myList)
  }
}

const Samples = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView, {
      fmt,
      model_name: 'Sample',
      delete_disabled: true,
      order_by: "!t",
      display_columns: ['t_human', 'recipe_name', 'volume_total', 'comment'],
      data_transform_callback: (data) => {
            return data.map(record => {
                record.volume_total = record.volume_total.toFixed(1) + ' m³'
                return record
            })
      },
    })
    return m(ListLayout, { fmt }, myList)
  }
}

const ReplaceMaterials = {
  oninit: vnode => {
    m.request({ url: 'select/Material' }).then(data => { vnode.state.data = data })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    // Build up selectboxes of materials
    const options = (vnode.state.data != null) ? vnode.state.data.data.map(x => m('option', { value: x.id }, x.name)) : []
    const EmptyOption = [m('option', { value: null }, '-')]
    const OptionsDefaults = [...EmptyOption, ...options]

    return m(Layout, { fmt },
        m(FormHeader, fmt('{Replace materials}')),
        m('.mx-4.py-2.mt-2',
            m('', fmt('{Here you can bulk replace materials in all recipes. Volume and delay will not be altered.}')),
            m('select', { onchange: e => { vnode.state.material_from = e.target.value } }, OptionsDefaults),
            m('span.mx-4', '->'),
            m('select', { onchange: e => { vnode.state.material_to = e.target.value } }, OptionsDefaults),
            m('span.col-sm-12.col-md-7', m(m.route.Link, {
              href: '/recipes',
              class: 'btn btn-primary px-4 py-1',
              onclick: _e => {
                m.request({
                  url: 'do_replace_material',
                  method: 'POST',
                  body: {
                    from: vnode.state.material_from,
                    to: vnode.state.material_to
                  }
                }).then((data) => { ServerMessages.set(data) })
              }
            }, fmt('{Bulk replace}')))
      )
    )
  }
}

const StockUpMaterials = {
  oninit: vnode => {
    vnode.state.loading = true
    m.request({ url: 'select/Material' }).then(data => {
        vnode.state.data = data
        const actualDate = new Date()
        vnode.state.data.date = std_date_format(actualDate)
        vnode.state.data.time = std_time_format(actualDate)
        vnode.state.loading = false
    })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    // Build up selectboxes of materials
    const options = (vnode.state.data != null)
          ? vnode.state.data.data.map(x => m('option', { value: x.id }, x.name))
          : []
    const EmptyOption = [m('option', { value: null }, '-')]
    const AllOptions = [...EmptyOption, ...options]
    const fields = vnode.state.loading ? {} : {
      material: m(SimpleSelectBox, { options: AllOptions, title: fmt('{Material}') }),
      amount: m(InputField, { required: true, number: true, fmt, title: fmt('{amount}') }),
      comment: m(InputField, { full_width: true, fmt, title: fmt('{comment}') } ),
      date: m(InputField, {
          value: vnode.state.data.date,
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date}'),
          onchange_callback: x => { vnode.state.data.date = x },
      }),
      time: m(InputField, {
          value: vnode.state.data.time,
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time}'),
          onchange_callback: x => { vnode.state.data.time = x },
      }),
    }

    return m(Layout, { fmt },
        m(FormHeader, fmt('{Material stock up}')),
        formFieldsToLayout(fields),
        m(SimpleSubmitButton, { fmt, my_onclick: () => {
            MyPostRequest("/stockup", DataFromFormFields(fields), "/materials")
        }})
    )
  }
}

const OpenTransportType = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/TransportType/' + vnode.attrs.id }).then(data => {
        vnode.state.data = data
      })
    } else {
      vnode.state.data = { name: null }
    }
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{name}'),
            onchange_callback: x => { vnode.state.data.name = x },
        }),
    } : {}

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => { MyPostRequest(
            (vnode.attrs.id != null) ? 'update/TransportType/' + vnode.attrs.id : 'add/TransportType',
            DataFromFormFields(fields),
            "/transport_types"
        )}})
    )
  }
}

const TransportTypes = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = "TransportType"
    const myList = m(ListView, {
        fmt,
        model_name,
        detail_url: '/transport_type_open/',
        hideable: true,
        display_columns: ['name'],
    })
    return m(ListLayout, {fmt, add_url: userLocks.isLocked(model_name) ? null : '/transport_type_open/', hideable: true}, myList)
  }
}

const OpenDriver = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/Driver/' + vnode.attrs.id }).then(data => {
        vnode.state.data = data
      }).catch(err => {
        if (err.code === 401) {
            m.route.set("/login")
        }
        vnode.state.data = {}
      })
    } else {
      vnode.state.data = { name: null }
    }
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{driver}'),
            onchange_callback: x => { vnode.state.data.name = x },
        }),
        contact: m(InputField, {
            value: vnode.state.data.contact,
            fmt,
            title: fmt('{contact}'),
            onchange_callback: x => { vnode.state.data.contact = x },
        }),
        comment: m(InputField, {
            value: vnode.state.data.comment,
            full_width: true,
            fmt,
            title: fmt('{Note}'),
            onchange_callback: x => { vnode.state.data.comment = x },
        }),
    } : {}

    return m(Layout, { fmt }, [
      m('.mt-4'),
      ...formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => {
          MyPostRequest(
            (vnode.attrs.id != null) ? 'update/Driver/' + vnode.attrs.id : 'add/Driver',
            vnode.state.data,
            "/drivers",
          )
      }}),
    ])
  }
}

const Drivers = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = "Driver"
    const myList = m(ListView, {
        fmt,
        model_name,
        detail_url: '/driver_open/',
        hideable: true,
        display_columns: ['name', 'contact', 'comment'],
    })
    return m(ListLayout, {
        fmt,
        add_url: userLocks.isLocked(model_name) ? null : '/driver_open/',
        hideable: true,
    }, myList)
  }
}

const Vehicles = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = "Car"
    const myList = m(ListView, {
      fmt,
      model_name,
      detail_url: '/vehicle_open/',
      hideable: true,
      display_columns: GlobalConfig.setup.transport_zones ?
        ['registration_number', '_driver_name', '_driver_contact', 'charge_transport_automatically', 'car_type', '_transport_type_name', 'operator', 'comment'] :
        ['registration_number', '_driver_name', '_driver_contact', 'price_per_km', 'car_type', '_transport_type_name', 'operator', 'comment'],
      columnNames: {"_driver_name": "{driver_name}", "_driver_contact": "{driver_contact}", "_transport_type_name": "{transport_type_name}"},
    })
    return m(ListLayout, {
        fmt,
        add_url: userLocks.isLocked(model_name) ? null : '/vehicle_open/',
        hideable: true,
    }, myList)
  }
}

// TODO: find a better name
const oneToElement = (x, vnode, fmt, onChange) => {
    if (x._bool) {
        return m(CheckBox2, {
            value: vnode.state.data[x.k],
            label: fmt(x.label),
            fmt,
            onchange_callback: v => {
                vnode.state.data[x.k] = v
                if (onChange) {
                    onChange()
                }
            },
        })
    }
    if (x._smart) {
        return m(SmartSelectBox2, {
            field_name: x.k,
            value: vnode.state.data[x.k],
            options: x.options,
            fmt,
            onchange_callback: v => {
                vnode.state.data[x.k] = v
                if (onChange) {
                    onChange()
                }
            },
        })
    }
    if (x.options) {
        return m(SimpleSelectBox2, {
            value: vnode.state.data[x.k],
            options: x.options,
            fmt,
            onchange_callback: v => {
                vnode.state.data[x.k] = v
                if (onChange) {
                    onChange()
                }
            },
        })
    }
    return m(InputField, {
        value: vnode.state.data[x.k],
        required: x.required,
        number: x.number,
        full_width: x.full_width,
        disabled: x.disabled,
        fmt,
        onchange_callback: v => {
            vnode.state.data[x.k] = v
            if (onChange) {
                onChange()
            }
        },
    })
}

// TODO: find a better name
const formToElements = (frm, vnode, fmt, onChange) => {
    return frm.map(x => {
        return m(".row.mx-4.py-1", [
            m(".col-sm-12.col-md-4.text-md-right", { class: x.required ? "bold" : "" }, fmt(x.title)),
            m(".col-sm-12.col-md-8.row", oneToElement(x, vnode, fmt, onChange)),
        ])
    })
}

const OpenModel = model_name => {
    const updateForm = vnode => {
      console.debug("updateForm", vnode)
      m.request({
        url: 'detail2/' + model_name + '/' + (vnode.attrs.id || ""),
        method: "POST",
        //params: vnode.state.data,
        body: vnode.state.data,
      })
      .then(data => {
        vnode.state.data = data.item || {}
        vnode.state._form = data.form
      })
    }

    return {
      oninit: vnode => {
        vnode.state.data = {}
        vnode.state._form = []
        updateForm(vnode)
        /*m.request({
            url: 'detail2/' + model_name + '/' + (vnode.attrs.id || ""),
            params: vnode.state.data,
        })
        .then(data => {
          vnode.state.data = data.item || {}
          vnode.state._form = data.form
        })*/
      },


      view: vnode => {
        const fmt = vnode.attrs.fmt
        const fields = formToElements(vnode.state._form, vnode, fmt, () => {
          updateForm(vnode)
        })
        return m(Layout, { fmt },
          m('.mt-4'),
          ...fields,
          m('.mt-4'),
          m(SimpleSubmitButton, {
              fmt,
              back_button: true,
              my_onclick: () => {
                  MyPostRequest(
                    (vnode.attrs.id != null) ? ('update/' + model_name + '/' + vnode.attrs.id) : ('add/' + model_name),
                    keyFilter(vnode.state.data, k => !k.startsWith("_")),
                  )
                  history.back()
              },
          })
        )
      }
    }
}

const TransportZones = {
  oninit: vnode => {
      vnode.state.filter_string = ""
  },
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView2, {
      fmt,
      model_name: 'TransportZone',
      detail_url: '/transport_zone_open/',
      filter_string: vnode.state.filter_string,
      show_hidden: vnode.state.show_hidden,
    })
    return m(ListLayout2, {
        fmt,
        add_url: '/transport_zone_open/',
        //on_filter_change: x => { vnode.state.filter_string = x },
        on_filter_change: x => { myList.tag.on_filter_change(myList, x) },
        on_show_hidden_change: x => { myList.tag.on_show_hidden_change(myList, x) },
    }, myList)
  }
}


/*const OpenPumpSurcharge = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/PumpSurcharge/' + vnode.attrs.id }).then(data => { vnode.state.data = data })
    } else {
        vnode.state.data = {name: ""}
    }
  },

  sanitizedValues: fields => {  // Takes care that nonsenses aren't send to save endpoint
    let ret = DataFromFormFields(fields)
    if (ret.price_type != 2) {
        ret.unit_name = null
    }
    return ret
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{name}'),
            onchange_callback: x => { vnode.state.data.name = x },
        }),
        export_name: m(InputField, {
            value: vnode.state.data.export_name,
            fmt,
            title: fmt('{export_name}'),
            onchange_callback: x => { vnode.state.data.export_name = x },
        }),
        price: m(InputField, {
            value: vnode.state.data.price,
            number: true,
            fmt,
            title: fmt('{price}'),
            onchange_callback: x => { vnode.state.data.price = x },
        }),
        price_type: m(SimpleSelectBox, {
          value: vnode.state.data.price_type,
          options: hashtable_to_selectbox(fmt, GlobalConfig.pump_surcharge_price_types),
          title: fmt('{price_type}'),
          onchange_callback: value => {
            fields.unit_name.state.disabled = (value != 2)
          } }),
        unit_name: m(InputField, {
            value: vnode.state.data.unit_name,
            fmt,
            title: fmt('{unit_name}'),
            disabled: (vnode.state.data.price_type != 2),
            onchange_callback: x => { vnode.state.data.unit_name = x },
        }),
    } : {}

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => { MyPostRequest(
            (vnode.attrs.id != null) ? 'update/PumpSurcharge/' + vnode.attrs.id : 'add/PumpSurcharge',
            OpenPumpSurcharge.sanitizedValues(fields),
            "/pump_surcharges"
        )}})
    )
  }
}*/

const PumpSurcharges = {
  translate_data: (data) => {
    return data.map(record => {
        record.price_type = '{' + GlobalConfig.pump_surcharge_price_types[record.price_type] +'}'
        record.price = rounded(record.price)
        return record
    })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView, {
      fmt,
      model_name: 'PumpSurcharge',
      detail_url: '/pump_surcharge_open/',
      data_transform_callback: PumpSurcharges.translate_data,
      display_columns: ['name', 'price', 'export_name', 'price_type', 'unit_name']
    })
    return m(ListLayout, {fmt, add_url: '/pump_surcharge_open/'}, myList)
  }
}

const OpenPump = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/Pump/' + vnode.attrs.id }).then(data => {vnode.state.data = data})
    } else {
        vnode.state.data = {registration_number: ""}
    }
    vnode.state.drivers = {}
    m.request({ url: 'select/Driver' }).then(data => { vnode.state.drivers=driversToSmartSelectBox(data) })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const dataLoaded = (Object.keys(vnode.state.data).length !== 0)
    const fields = dataLoaded ? {
        registration_number: m(InputField, {
            value: vnode.state.data.registration_number,
            required: true,
            fmt,
            title: fmt('{registration_number}'),
            onchange_callback: x => { vnode.state.data.registration_number = x },
        }),
        driver: m(SmartSelectBox, {
            fmt,
            value: vnode.state.data.driver,
            options: vnode.state.drivers,
            title: fmt('{driver}'),
            onchange_callback: x => { vnode.state.data.driver = x },
        }),
        pump_type: m(InputField, {
            value: vnode.state.data.pump_type,
            fmt,
            title: fmt('{pump_type}'),
            onchange_callback: x => { vnode.state.data.pump_type = x },
        }),
        price_per_km: m(InputField, {
            value: vnode.state.data.price_per_km,
            number: true,
            fmt,
            title: fmt('{price_per_km}'),
            onchange_callback: x => { vnode.state.data.price_per_km = x },
        }),
        price_per_hour: m(InputField, {
            value: vnode.state.data.price_per_hour,
            number: true,
            fmt,
            title: fmt('{price_per_hour}'),
            onchange_callback: x => { vnode.state.data.price_per_hour = x },
        }),
        comment: m(InputField, {
            value: vnode.state.data.comment,
            full_width: true,
            fmt,
            title: fmt('{Note}'),
            onchange_callback: x => { vnode.state.data.comment = x },
        })
    } : {}

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => {
        const mydata = DataFromFormFields(fields)
        /* TODO REF This is a temporary hack (used X times in "edit" dialogs), to handle situation, when user
             deletes value from SmartSelectBox. Such empty value is set to empty string, but we need "null"
             on backend (it is foreignkey). Probably needs just a small rewrite of SmartSelectBox
             component, but it is used everywhere so it implies alot of manual testing.
        */
        mydata.driver = (mydata.driver == "") ? null : mydata.driver
        MyPostRequest(
            (vnode.attrs.id != null) ? 'update/Pump/' + vnode.attrs.id : 'add/Pump',
            mydata,
            "/pumps"
        )}})
    )
  }
}

const Pumps = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = "Pump"
    const myList = m(ListView, {
      fmt,
      model_name,
      detail_url: '/pump_open/',
      hideable: true,
      data_transform_callback: (data) => {
            return data.map(record => {
                record.price_per_km = rounded(record.price_per_km)
                record.price_per_hour = rounded(record.price_per_hour)
                return record
            })
      },
      display_columns: ['registration_number', '_driver_name', '_driver_contact', 'pump_type', 'price_per_km', 'price_per_hour', 'comment'],
      columnNames: {"_driver_name": "{driver_name}", "_driver_contact": "{driver_contact}"},
    })
    return m(ListLayout, {fmt, add_url: userLocks.isLocked(model_name) ? null : '/pump_open/', hideable: true}, myList)
  }
}

/* Create new pump order */
const PumpOrder = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      m.request({ url: 'detail/PumpOrder/' + vnode.attrs.id }).then(data => {
        vnode.state.data = data;
        vnode.state.surcharges = vnode.state.data.surcharges
        for(const x of vnode.state.surcharges) { x.price = x.price_unit }  //  PumpOrderSurcharge field name for price is different from those in PumpSurcharge
        vnode.state.surcharges.push({})  // empty slot for a new surcharge
        PumpOrder.on_pump_change(vnode, vnode.state.data.pump_record)
      })
    } else {
      vnode.state.data = {}
    }
    m.request({ url: 'select/Pump' }).then(data => {
        vnode.state.pumps = nonHiddenRecordsToNamesObject(data.data, x => x.registration_number)
    })
    m.request({ url: 'select/Customer' }).then(data => {
        vnode.state.customers = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    })
    m.request({ url: 'select/ConstructionSite' }).then(data => {
        vnode.state.construction_sites = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    })
    vnode.state.surcharges = [{}]  // Surcharges entered by user
  },

  on_pump_change: (vnode, id) => {
        vnode.state.data.pump_record = id
        m.request({ url: 'detail/Pump/' + id }).then(data => {
            vnode.state.pump = data
            PumpOrder.recount_price(vnode)
        })
  },

  recount_price: vnode => {
    const fmt = vnode.attrs.fmt
    const priceHours = (vnode.state.pump && vnode.state.data.hours) ? (vnode.state.pump.price_per_hour * vnode.state.data.hours) : 0
    const priceKm = (vnode.state.pump && vnode.state.data.kms) ? (vnode.state.pump.price_per_km * vnode.state.data.kms) : 0

    // TODO REF duplicate constants with model.SURCHARGE_PRICE_FIXED and so on. Similar issue as with order surcharges.
    //   Maybe move (at least partially) to Surcharge component?
    let priceSurcharges = 0
    for(const surcharge of vnode.state.surcharges) {
        if(surcharge.price_type == 0) { // fixed
            priceSurcharges += surcharge.price
        } else if (surcharge.price_type == 2) { // per other unit
            priceSurcharges += surcharge.price * (surcharge.amount || 0)
        }
    }

    const priceTotal = priceHours + priceKm + priceSurcharges
    vnode.state.priceInfo = priceTotal ? fmt("{price_expected}: " + with_currency(rounded(priceTotal))) : null
    vnode.state.pumpNoPriceHourWarning = (vnode.state.pump && !vnode.state.pump.price_per_hour) ? fmt("{pump_without_price_hour}") : null
    vnode.state.pumpNoPriceKmWarning = (vnode.state.pump && !vnode.state.pump.price_per_km) ? fmt("{pump_without_price_km}") : null

    // TODO REF NTH this crazy string construction could be probably done nicer by passing proper format string directly to fmt function, but it's undocumented and I don't know how it works
    vnode.state.pumpPriceInfo = (vnode.state.pump && vnode.state.pump.price_per_km && vnode.state.pump.price_per_hour) ?
        (fmt("{pump}: {pump_price_hour}: ") + with_currency(vnode.state.pump.price_per_hour) + ", " +  fmt("{pump_price_km}: ") + with_currency(vnode.state.pump.price_per_km)) : null
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const recordLoaded = vnode.attrs.id ? (vnode.state.data ? true : false) : true
    const dataLoaded = (vnode.state.pumps && vnode.state.customers && vnode.state.construction_sites && recordLoaded)
    const fields = dataLoaded ? {
        pump: m(SmartSelectBox, {
            value: vnode.state.data.pump_record,
            fmt,
            required: true,
            options: vnode.state.pumps,
            title: fmt('{pump}'),
            onchange_callback: id => { PumpOrder.on_pump_change(vnode, id) },
        }),
        customer: m(SmartSelectBox, {
            value: vnode.state.data.customer_record,
            fmt,
            options: vnode.state.customers,
            title: fmt('{customer}'),
            onchange_callback: id => { vnode.state.data.customer_record = id },
        }),
        construction_site: m(SmartSelectBox, {
            value: vnode.state.data.construction_site_record,
            fmt,
            options: vnode.state.construction_sites,
            title: fmt('{construction_site}'), onchange_callback: id => {
                vnode.state.data.construction_site_record = id
                m.request({ url: 'detail/ConstructionSite/' + id }).then(data => {
                    vnode.state.data.kms = data.distance ? (distance_factor()*data.distance) : null
                    PumpOrder.recount_price(vnode)
                })
            },
        }),
        kms: m(InputField, {
            value: vnode.state.data.kms,
            number: true,
            fmt,
            title: fmt('{kms}'),
            onchange_callback: value => {
                vnode.state.data.kms = value
                PumpOrder.recount_price(vnode)
            },
        }),
        hours: m(InputField, {
            value: vnode.state.data.hours,
            number: true,
            fmt,
            title: fmt('{hours}'),
            onchange_callback: value => {
                vnode.state.data.hours = value
                PumpOrder.recount_price(vnode)
            },
        }),
    } : {}

    const surchargeRows = vnode.state.surcharges.map(x => m(Surcharge, {
        fmt,
        endpoint: 'select/PumpSurcharge',
        surcharge: x,
        onchange_callback: x => {
            // Add empty surcharge if there are no empty slots
            const emptySurcharges = vnode.state.surcharges.filter(x => !x.name)
            if (!emptySurcharges.length) {
                vnode.state.surcharges.push({})
            }
            PumpOrder.recount_price(vnode)
        },
        ondelete: x => {
            let index = null
            for (let i = 0; i < vnode.state.surcharges.length; i++) {
                if (vnode.state.surcharges[i].name == x.name) {
                    index = i
                }
            }
            vnode.state.surcharges.splice(index, 1)
            PumpOrder.recount_price(vnode)
        },
    }))

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(FormSubHeader, fmt("{surcharges}:")),
      m(".px-4", surchargeRows ),  // wrap to indented block, otherwise it is not especially pretty
      m(SimpleSubmitButton, {back_button: true, fmt, my_onclick: () => {
        const dataToSent = DataFromFormFields(fields)
        dataToSent.surcharges = vnode.state.surcharges
        for(const x of dataToSent.surcharges) {
            x.export_name = x._original_record_data ? x._original_record_data.export_name : null
        }
        MyPostRequest((vnode.attrs.id != null) ? 'update_pump_order/' + vnode.attrs.id : 'pump_order', dataToSent, "/pump_orders")
      }}),
      m(InfoBox, {level: "info", text: vnode.state.priceInfo}),
      m(InfoBox, {level: "info", text: vnode.state.pumpPriceInfo}),
      m(InfoBox, {level: "warning", text: vnode.state.pumpNoPriceHourWarning}),
      m(InfoBox, {level: "warning", text: vnode.state.pumpNoPriceKmWarning}),
    )
  }
}

const PumpOrders = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView, {
      fmt,
      model_name: 'PumpOrder',
      hideable: true,
      delete_disabled: true,
      detail_url: '/pump_order/',
      actions: [
        { icon: 'fas.fa-file-alt.text-success', name: fmt('{pumping_sheet}'), href: '/print/pumping_sheet/:id?lang=' + vnode.attrs.lang },
      ],
      display_columns: ['auto_number', 't_human', 'pump_registration_number', 'construction_site_name', 'customer_name', 'kms', 'hours']
    })
    return m(ListLayout, {fmt, hideable: true}, myList)
  }
}

const OpenCompanySurcharge = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/CompanySurcharge/' + vnode.attrs.id }).then(data => { vnode.state.data = data })
    } else {
        vnode.state.data = {name: ""}
    }
  },

  sanitizedValues: fields => {  // Takes care that nonsenses aren't send to save endpoint
    let ret = DataFromFormFields(fields)
    if (ret.price_type != 2) {
        ret.unit_name = null
    }
    return ret
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{name}'),
            onchange_callback: x => { vnode.state.data.name = x },
        }),
        price: m(InputField, {
            value: vnode.state.data.price,
            number: true,
            fmt,
            title: fmt('{price}'),
            onchange_callback: x => { vnode.state.data.price = x },
        }),
        price_type: m(SimpleSelectBox, {
          value: vnode.state.data.price_type,
          options: hashtable_to_selectbox(fmt, GlobalConfig.company_surcharge_price_types),
          title: fmt('{price_type}'),
          onchange_callback: value => {
            fields.unit_name.state.disabled = (value != 2)
          }
        }),
        unit_name: m(InputField, {
            value: vnode.state.data.unit_name,
            fmt,
            title: fmt('{unit_name}'),
            disabled: (vnode.state.data.price_type != 2),
            onchange_callback: x => { vnode.state.data.unit_name = x },
        }),
    } : {}

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => { MyPostRequest(
            (vnode.attrs.id != null) ? 'update/CompanySurcharge/' + vnode.attrs.id : 'add/CompanySurcharge',
            OpenCompanySurcharge.sanitizedValues(fields),
            "/company_surcharges"
        )}})
    )
  }
}

const CompanySurcharges = {
  translate_data: (data) => {
    return data.map(record => {
        record.price_type = '{' + GlobalConfig.company_surcharge_price_types[record.price_type] +'}'
        record.price = rounded(record.price)
        return record
    })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView, {fmt, model_name: 'CompanySurcharge', detail_url: '/company_surcharge_open/', display_columns: ['name', 'price', 'price_type', 'unit_name'], data_transform_callback: CompanySurcharges.translate_data})
    return m(ListLayout, {fmt, add_url: '/company_surcharge_open/'}, myList)
  }
}

const OpenDiscount = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/Price/' + vnode.attrs.id }).then(data => {vnode.state.data = data})
    } else {
      vnode.state.data = {customer: null, recipe: null}
    }

    vnode.state.customer = {}
    m.request({ url: 'detail/Customer/' + vnode.attrs.customer }).then(data => {
        vnode.state.customer = data
        vnode.state.customer_description = data.company_idnum ? (data.name + ' (' + data.company_idnum + ')') : data.name
    })

    vnode.state.recipes = {}
    m.request({ url: 'select/Recipe' }).then(data => {
      for (const x of data.data) {
        vnode.state.recipes[x.id] = x.name + (x.description ? ' (' + x.description + ')' : "")
      }
    })

    vnode.state.construction_sites = {}
    m.request({ url: 'select/ConstructionSite' }).then(data => {
      for (const x of data.data) {
        vnode.state.construction_sites[x.id] = x.name
      }
    })

  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        recipe: m(SmartSelectBox, {
            fmt,
            value: vnode.state.data.recipe,
            options: vnode.state.recipes,
            title: fmt('{recipe}'),
            onchange_callback: id => { vnode.state.data.recipe = id },
        }),
        construction_site: m(SmartSelectBox, {
            fmt,
            value: vnode.state.data.construction_site,
            options: vnode.state.construction_sites,
            title: fmt('{construction_site}'),
            onchange_callback: id => { vnode.state.data.construction_site = id },
        }),
        value: m(InputField, {
            fmt,
            required: true,
            value: vnode.state.data.value,
            title: fmt('{value}'),
            hint: fmt('{discount_value_hint}'),
            onchange_callback: x => { vnode.state.data.value = x },
        }),
    } : {}

    return m(Layout, { fmt },
      m(FormHeader, fmt("{custom_price}")),
      m(FormRow, fmt("{customer}:"), m(".bold", vnode.state.customer_description)),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => {
            const data = DataFromFormFields(fields)
            data.customer = vnode.attrs.customer
            data.recipe = (data.recipe == "") ? null : data.recipe
            data.construction_site = (data.construction_site == "") ? null : data.construction_site
            MyPostRequest((vnode.attrs.id != null) ? ('update/Price/' + vnode.attrs.id) : 'add/Price', data, "/customer_open/" + vnode.attrs.customer)
        }
      })
    )
  }
}

const OpenSite = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/ConstructionSite/' + vnode.attrs.id }).then(data => {
        vnode.state.data = data
        vnode.state.distanceDriven = data.distance ? (data.distance * 2) : null
      })
    } else {
      vnode.state.data = {
        name: null
      }
    }
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{name}'),
            onchange_callback: x => { vnode.state.data.name = x },
        }),
        address: m(InputField, {
            value: vnode.state.data.address,
            fmt,
            title: fmt('{Street and no}'),
            onchange_callback: x => { vnode.state.data.address = x },
        }),
        city: m(InputField, {
            value: vnode.state.data.city,
            fmt,
            title: fmt('{city}'),
            onchange_callback: x => { vnode.state.data.city = x },
        }),
        zip: m(InputField, {
            value: vnode.state.data.zip,
            fmt,
            title: fmt('{zip}'),
            onchange_callback: x => { vnode.state.data.zip = x },
        }),
        distance: m(InputField, {
            value: vnode.state.data.distance,
            number: true,
            fmt,
            title: fmt('{distance}'),
            onchange_callback: x => {
                vnode.state.data.distance = x
                vnode.state.distanceDriven = x ? (x*2) : null
            },
        }),
        comment: m(InputField, {
            value: vnode.state.data.comment,
            full_width: true,
            fmt,
            title: fmt('{Note}'),
            onchange_callback: x => { vnode.state.data.comment = x },
        })
      } : {}

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(FormRow, "", m(".italic", fmt("{distance_driven_info}") + (vnode.state.distanceDriven ? vnode.state.distanceDriven : "?")   + " km")),
      m(SimpleSubmitButton, {
          fmt,
          back_button: true,
          my_onclick: () => { MyPostRequest(
            (vnode.attrs.id != null) ? 'update/ConstructionSite/' + vnode.attrs.id : 'add/ConstructionSite',
            DataFromFormFields(fields),
            "/sites"
         )},
      })
    )
  }
}

const Sites = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = 'ConstructionSite'
    const myList =  m(ListView, {
        fmt,
        model_name,
        detail_url: '/site_open/',
        hideable: true,
        display_columns: ['name', 'address', 'city', 'zip', 'distance', 'comment'],
    })
    return m(ListLayout, {fmt, add_url: userLocks.isLocked(model_name) ? null : '/site_open/', hideable: true}, myList)
  }
}

const OpenCustomer = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/Customer/' + vnode.attrs.id }).then(data => {vnode.state.data = data})
    } else {
      vnode.state.data = {
        payment_type: 0, // cash - TODO REF: un-hard-code this - get something like "default_payment_type" from backend or something...
        name: null
      }
    }
  },

  data_transform_callback: (data) => {
    return data.map(record => {
        // Display explicitly, if it is a discount or surcharge
        let statusColor = null
        let comment = null
        if (record.type != 1) { // can't judge absolute prices
            if (record.amount > 0) {
                statusColor = "text-danger"
                comment = "{surcharge}"
            } else {
                statusColor = "text-success"
                comment = "{discount}"
            }
        }
        record.comment = m(".bold." + statusColor, comment)
        return record
  })},

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{name}'),
            onchange_callback: x => { vnode.state.data.name = x },
        }),
        company_idnum: m(InputField, {
            value: vnode.state.data.company_idnum,
            fmt,
            title: fmt('{company_idnum}'),
            onchange_callback: x => { vnode.state.data.company_idnum = x },
        }),
        vat_idnum: m(InputField, {
            value: vnode.state.data.vat_idnum,
            fmt,
            title: fmt('{Vat ID}'),
            onchange_callback: x => { vnode.state.data.vat_idnum = x },
        }),
        address: m(InputField, {
            value: vnode.state.data.address,
            fmt,
            title: fmt('{Street and no}'),
            onchange_callback: x => { vnode.state.data.address = x },
        }),
        city: m(InputField, {
            value: vnode.state.data.city,
            fmt,
            title: fmt('{city}'),
            onchange_callback: x => { vnode.state.data.city = x },
        }),
        zip: m(InputField, {
            value: vnode.state.data.zip,
            fmt,
            title: fmt('{zip}'),
            onchange_callback: x => { vnode.state.data.zip = x },
        }),
        phone: m(InputField, {
            value: vnode.state.data.phone,
            fmt,
            title: fmt('{phone}'),
            onchange_callback: x => { vnode.state.data.phone = x },
        }),
        fax: m(InputField, {
            value: vnode.state.data.fax,
            fmt,
            title: fmt('{fax}'),
            onchange_callback: x => { vnode.state.data.fax = x },
        }),
        email: m(InputField, {
            value: vnode.state.data.email,
            fmt,
            title: fmt('{email}'),
            onchange_callback: x => { vnode.state.data.email = x },
        }),
        payment_type: m(PaymentType, {
            value: vnode.state.data.payment_type,
            fmt,
            title: fmt("{Payment}"),
            onchange_callback: x => { vnode.state.data.payment_type = x }
        }),
        comment: m(InputField, {
            value: vnode.state.data.comment,
            full_width: true,
            fmt,
            title: fmt('{Note}'),
            onchange_callback: x => { vnode.state.data.comment = x },
        }),
      } : {}

    const aresButton = GlobalConfig.setup.ares_disabled
        ? null
        : m('.btn.btn-dark.px-2.py-1.pointer', {
              onclick: _e => {
                vnode.state.aresLoading = true
                m.request({ url: 'ares/' + fields.company_idnum.state.value }).then(data => {
                  vnode.state.aresLoading = false
                  for (const ValueName of ['name', 'zip', 'city', 'address']) {
                    if (data[ValueName] != null) {
                        vnode.state.data[ValueName] = data[ValueName]
                    }
                  }
                })
              }
        }, fmt('{Get company data from ARES}'))

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(FormRow, '', vnode.state.aresLoading ? m(Loading, {small: true}) : aresButton),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => { MyPostRequest(
            (vnode.attrs.id != null) ? 'update/Customer/' + vnode.attrs.id : 'add/Customer',
            vnode.state.data,
            "/customers"
         )}
      }),

      // List of customer's custom prices
      (vnode.attrs.id && GlobalConfig.setup.module_prices)
          ? [ m(".row",
                m(".col-2", m('.h4', fmt("{custom_prices}:"))),
                m(".col-6.p-0", m(m.route.Link, { href: '/discount_open/'  + vnode.attrs.id, class: 'btn btn-primary fas fa-plus px-5 ml-0 py-2 mx-1' })),
              ),
              m('.mt-3', m(ListView, {
                  fmt,
                  delete_endpoint: "delete/Price",
                  detail_url: '/discount_open/' + vnode.attrs.id + "/",
                  select_endpoint: "customer_prices/" + vnode.attrs.id,
                  data_transform_callback: OpenCustomer.data_transform_callback,
                  display_columns: ['recipe_name', 'construction_site_name', 'value_str', 'comment']
            })) ]
          : null
    )
  }
}

const Customers = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = "Customer"
    const myList = m(ListView, {
        fmt,
        model_name,
        detail_url: '/customer_open/',
        hideable: true,
        display_columns: ['name', 'company_idnum', 'address', 'city', 'zip', 'phone', 'email'],
    })
    return m(ListLayout, {fmt, add_url: userLocks.isLocked(model_name) ? null : '/customer_open/', hideable: true}, myList)
  }
}

const OpenContract = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.data = {}
      m.request({ url: 'detail/Contract/' + vnode.attrs.id }).then(data => {
        vnode.state.data = data
      }).catch(err => {
        if (err.code === 401) {
            m.route.set("/login")
        }
      })
    } else {
      vnode.state.data = {
        name: null,
        customer: null,
        construction_site: null,
        vehicle: null,
        recipe: null
      }
    }

    // Get customers, transform it to structure that can be used in SmartSelectBox
    vnode.state.customers = {}
    m.request({ url: 'select/Customer' }).then(data => {
      for (const x of data.data) {
        vnode.state.customers[x.id] = x.company_idnum ? (x.name + ' (' + x.company_idnum + ')') : x.name
      }
    })

    // ditto construction sites
    vnode.state.sites = {}
    m.request({ url: 'select/ConstructionSite' }).then(data => {
      for (const x of data.data) {
        vnode.state.sites[x.id] = x.city ? (x.name + ' (' + x.city + ')') : x.name
      }
    })
    vnode.state.recipes = {}
    m.request({ url: 'select/Recipe' }).then(data => {
      for (const x of data.data) {
        vnode.state.recipes[x.id] = x.name + (x.description ? ' (' + x.description + ')' : "")
      }
    })
    vnode.state.vehicles = {}
    m.request({ url: 'select/Car' }).then(data => {
      for (const x of data.data) {
        vnode.state.vehicles[x.id] = x.registration_number + (x.comment ? ' (' + x.comment + ')' : "")
      }
    })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        name: m(InputField, {
            value: vnode.state.data.name,
            required: true,
            fmt,
            title: fmt('{name}'),
            onchange_callback: x => { vnode.state.data.name = x },
        }),
        customer: m(SmartSelectBox, {
            fmt,
            required: true,
            value: vnode.state.data.customer,
            options: vnode.state.customers,
            title: fmt('{customer}'),
            onchange_callback: id => { vnode.state.data.customer = id },
        }),
        construction_site: m(SmartSelectBox, {
            fmt,
            required: true,
            value: vnode.state.data.construction_site,
            options: vnode.state.sites,
            title: fmt('{construction_site}'),
            onchange_callback: id => { vnode.state.data.construction_site = id },
        }),
        recipe: m(SmartSelectBox, {
            fmt,
            value: vnode.state.data.recipe,
            options: vnode.state.recipes,
            title: fmt('{recipe}'),
            onchange_callback: id => { vnode.state.data.recipe = id },
        }),
        vehicle: m(SmartSelectBox, {
            fmt,
            value: vnode.state.data.vehicle,
            options: vnode.state.vehicles,
            title: fmt('{vehicle}'),
            onchange_callback: id => { vnode.state.data.vehicle = id },
        }),
        default_volume: m(InputField, {
            fmt,
            value: vnode.state.data.default_volume,
            number: true,
            fmt,
            title: fmt('{default_volume}'),
            onchange_callback: x => { vnode.state.data.default_volume = x },
        }),
        comment: m(InputField, {
            value: vnode.state.data.comment,
            full_width: true,
            fmt,
            title: fmt('{Note}'),
            onchange_callback: x => { vnode.state.data.comment = x },
        })
    } : {}

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => {
          const data = DataFromFormFields(fields)
          data.customer = (data.customer == "") ? null : data.customer
          data.construction_site = (data.construction_site == "") ? null : data.construction_site
          data.recipe = (data.recipe == "") ? null : data.recipe
          data.vehicle = (data.vehicle == "") ? null : data.vehicle
          MyPostRequest(
            (vnode.attrs.id != null) ? ('update/Contract/' + vnode.attrs.id) : 'add/Contract',
            data,
            "/contracts"
         )}
      })
    )
  }
}

const Contracts = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const model_name = 'Contract'
    const myList = m(ListView, {
      fmt,
      model_name,
      detail_url: '/contract_open/',
      hideable: true,
      display_columns: ['name', 'construction_site_name', 'customer_name', 'recipe_name', 'vehicle_registration_number', 'default_volume', 'comment']
    })
    return m(ListLayout, {fmt, add_url: userLocks.isLocked(model_name) ? null : '/contract_open/', hideable: true}, myList)
  }
}

const Setup = {
  oninit: vnode => {
    vnode.state.data = {}
    m.request({ url: 'get_setup' }).then(data => {
      vnode.state.data = (Object.keys(data).length > 0) ? data : { company_name: 'Company', order_num_counter: 1 }
    })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const vsd = vnode.state.data
    const fields = (Object.keys(vsd).length !== 0) ? {
        company_name: m(InputField, {
            value: vsd.company_name,
            required: true,
            fmt,
            title: fmt('{Company name}'),
            onchange_callback: x => { vnode.state.data.company_name = x },
        }),
        company_address: m(InputField, {
            value: vsd.company_address,
            fmt,
            title: fmt('{Street and no}'),
            onchange_callback: x => { vnode.state.data.company_address = x },
        }),
        company_city: m(InputField, {
            value: vsd.company_city,
            fmt,
            title: fmt('{city}'),
            onchange_callback: x => { vnode.state.data.company_city = x },
        }),
        company_zip: m(InputField, {
            value: vsd.company_zip,
            fmt,
            title: fmt('{zip}'),
            onchange_callback: x => { vnode.state.data.company_zip = x },
        }),
        company_idnum: m(InputField, {
            value: vsd.company_idnum,
            fmt,
            title: fmt('{company_idnum}'),
            onchange_callback: x => { vnode.state.data.company_idnum = x },
        }),
        company_vat_idnum: m(InputField, {
            value: vsd.company_vat_idnum,
            fmt,
            title: fmt('{Vat ID}'),
            onchange_callback: x => { vnode.state.data.company_vat_idnum = x },
        }),
        facility_name: m(InputField, {
            value: vsd.facility_name,
            fmt,
            title: fmt('{Facility name}'),
            onchange_callback: x => { vnode.state.data.facility_name = x },
        }),
        facility_address: m(InputField, {
            value: vsd.facility_address,
            fmt,
            title: fmt('{Street and no}'),
            onchange_callback: x => { vnode.state.data.facility_address = x },
        }),
        facility_city: m(InputField, {
            value: vsd.facility_city,
            fmt,
            title: fmt('{city}'),
            onchange_callback: x => { vnode.state.data.facility_city = x },
        }),
        facility_zip: m(InputField, {
            value: vsd.facility_zip,
            fmt,
            title: fmt('{zip}'),
            onchange_callback: x => { vnode.state.data.facility_zip = x },
        }),
        facility_code: m(InputField, {
            value: vsd.facility_code,
            fmt,
            title: fmt('{Facility code}'),
            onchange_callback: x => { vnode.state.data.facility_code = x },
        }),
        currency_symbol: m(InputField, {
            value: vsd.currency_symbol,
            fmt,
            title: fmt('{currency_symbol}'),
            onchange_callback: x => { vnode.state.data.currency_symbol = x },
        }),
        vat_rate: m(InputField, {
            value: vsd.vat_rate,
            integer: true,
            fmt,
            title: fmt('{vat_rate}'),
            hint: fmt('{vat_rate_hint}'),
            onchange_callback: x => { vnode.state.data.vat_rate = x },
        }),
        order_num_counter: m(InputField, {
            value: vsd.order_num_counter,
            number: true,
            fmt,
            title: fmt('{Order numeric series}'),
            onchange_callback: x => { vnode.state.data.order_num_counter = x },
        }),
        invoice_num_counter: m(InputField, {
            value: vsd.invoice_num_counter,
            number: true,
            fmt,
            title: fmt('{invoice_numeric_series}'),
            onchange_callback: x => { vnode.state.data.invoice_num_counter = x },
        }),
        pumporder_num_counter: GlobalConfig.setup.module_pumps
          ? m(InputField, {
            value: vsd.pumporder_num_counter,
            number: true,
            fmt,
            title: fmt('{pumporder_numeric_series}'),
            onchange_callback: x => { vnode.state.data.pumporder_num_counter = x },
          })
          : null,
        datetime_format: m(InputField, {
            value: vsd.datetime_format,
            fmt,
            title: fmt('{datetime_format_string}'),
            placeholder: "YYYY-MM-DD HH:mm:ss",
            hint: fmt('{datetime_format_string_hint}'),
            onchange_callback: x => { vnode.state.data.datetime_format = x },
        }),
        count_distance_doubled: m(CheckBox, {
            value: vsd.count_distance_doubled,
            fmt,
            hint: fmt('{count_distance_doubled_hint}'),
        }, fmt('{count_distance_doubled}')),
        auto_print: m(CheckBox, {
            value: vsd.auto_print,
            fmt,
            hint: fmt('{auto_print_hint}'),
        }, fmt('{auto_print}')),
    } : {}
    const fields_printout = (Object.keys(vsd).length !== 0) ? {
        company_legal: m(InputField, {
            value: vsd.company_legal,
            fmt,
            title: fmt('{Legal info}'),
            onchange_callback: x => { vnode.state.data.company_legal = x },
        }),
        certification_text: m(MultilineField, {
            value: vsd.certification_text,
            fmt,
            title: fmt('{Certification info}'),
        }),
        customer_consent: m(MultilineField, {
            value: vsd.customer_consent,
            fmt,
            title: fmt('{customer_affirmation}'),
        }),
        customer_consent_pump: m(MultilineField, {
            value: vsd.customer_consent_pump,
            fmt,
            title: fmt('{customer_consent_pump}'),
        }),
    } : {}

    return m(Layout, { fmt }, [
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(FormSubHeader, fmt("{texts_for_printouts}") + ":"),
      formFieldsToLayout(fields_printout),
      m(SimpleSubmitButton, { fmt, my_onclick: () => {
        m.request({
          url: 'update_setup',
          method: 'POST',
          body: {...DataFromFormFields(fields), ...DataFromFormFields(fields_printout)},
        }).then((data) => {
          ServerMessages.set(data)
          if (data && !data.error) {
            m.route.set("/setup")
          }
          GlobalWrapper.reload_config()
        })
      }}),
    ])
  }
}

const Login = {
  oninit: vnode => {
    m.request({ url: 'get_users' }).then(data => {
      vnode.state.users = {}

      // Feature: preferably select last logged-in user
      const lastUser = window.localStorage.getItem("last_logged_in_user")
      if (lastUser) {
        vnode.state.firstUsername = lastUser
      }

      for (const x of data.data) {
        // HACK: we need to propagate 1st username into SimpleSelectBox value.
        // This component doesn't do it automatically, so when SelectBox is unchanged by user, value is "null"
        vnode.state.firstUsername = vnode.state.firstUsername ? vnode.state.firstUsername : x.username
        vnode.state.users[x.id] = x.username
      }
    })
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = vnode.state.users
        ? {
          username: m(SimpleSelectBox, {
            options: vnode.state.users,
            values_as_names: true,
            value: vnode.state.firstUsername,
            title: fmt('{username}'),
          }),
          password: m(InputField, { password: true, fmt, title: fmt('{Password}') })
        }
        : {}
    // FIXME: this is missing ServerMessages so possible error messages (on failed login etc.) are not being shown
    return m('',
      m('.w-50.mt-5.mx-auto.bg-dark.text-white.p-4.rounded', [
        m('h2.my-3.text-center', fmt('{Please log in:}')),
        formFieldsToLayout(fields),
        m(FormRow,
          m(''),
          m(StdButton, {
            text: fmt('{Login}'),
            onclick: _e => {
                const mydata =  DataFromFormFields(fields)
                window.localStorage.setItem("last_logged_in_user", mydata.username)
                MyPostRequest('do_login', mydata, "/", data => {
                    userLocks.setData(data)
                })
            },
          })
        ),
      ])
    )
  }
}

const OpenLockedTable = {
  /* Does not support 'edit', only 'add' - due to workflow, edit is not needed */

  view: vnode => {
    const fmt = vnode.attrs.fmt

    const options = { 0: "---"}
    if (GlobalConfig.lockable_tables) {
        for (const tbl of GlobalConfig.lockable_tables) {
            options[tbl] = fmt("{" + TABLE_NAME_MAPPING[tbl] + "}")
        }
    }

    const fields = {
        table_name: m(SimpleSelectBox, {options, fmt, title: fmt('{table_name}') }),
    }

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => {
          const data = DataFromFormFields(fields)
          data.user = vnode.attrs.user_id
          MyPostRequest('add/LockedTable', data, "/user_open/" + vnode.attrs.user_id)}
      }),
    )
  }
}

const OpenUser = {
  oninit: vnode => {
    if (vnode.attrs.id != null) {
      vnode.state.new_user = false
      vnode.state.data = {}
      m.request({ url: 'user_detail/' + vnode.attrs.id }).then(data => { vnode.state.data = data })
    } else {
      vnode.state.new_user = true
      vnode.state.data = {
        username: null,
        can_edit_users: false
      }
    }
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt

    const passwordMessage = vnode.state.new_user
      ? null
      : fmt('{Leave password field empty if you do not want to change it}')

    const fields = (Object.keys(vnode.state.data).length !== 0) ? {
        username: m(InputField, {
            value: vnode.state.data.username,
            required: true,
            fmt,
            title: fmt('{username}'),
            onchange_callback: value => { vnode.state.data.username = value },
        }),
        password: m(InputField, {
            value: vnode.state.data.password,
            required: vnode.state.new_user,
            hint: passwordMessage,
            fmt,
            title: fmt('{Password}'),
        }),
        can_edit_users: m(CheckBox, { value: vnode.state.data.can_edit_users }, fmt('{can_edit_users}'))
    } : {}

    return m(Layout, { fmt },
      m('.mt-4'),
      formFieldsToLayout(fields),
      m(SimpleSubmitButton, { fmt, back_button: true, my_onclick: () => { MyPostRequest(
            (vnode.attrs.id != null) ? 'update_user/' + vnode.attrs.id : 'add_user',
            DataFromFormFields(fields),
            "/users"
         )}
      }),

      // List of users locked tables
      vnode.attrs.id
          ? [ m(".mb-2.mt-5.d-flex",
                m(".mr-2", m('.h4', fmt("{locked_tables}:"))),
                m(".p-0", m(m.route.Link, { href: '/locked_table_open/'  + vnode.attrs.id, class: 'btn btn-primary fas fa-plus px-5 ml-0 py-2 mx-1' }))
              ),
              m('.mt-3', m(ListView, {
                  fmt,
                  model_name: "LockedTable",
                  select_endpoint: "user_locks/" + vnode.attrs.id,
                  display_columns: ['table_name'],
                  // TODO: useless closures
                  data_transform_callback: (data) => {
                        return data.map(record => {
                            record.table_name = fmt("{" + TABLE_NAME_MAPPING[record.table_name] + "}")
                            return record
                        })
                  },

            })) ]
          : null
    )
  }
}

const Users = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const myList = m(ListView, {
      fmt,
      model_name: "User",
      delete_endpoint: '/delete_user',
      detail_url: '/user_open/',
      display_columns: ['username', 'can_edit_users']
    })
    return m(ListLayout, {fmt, add_url: '/user_open/'}, myList)
  }
}

const SampleMsgbox = {
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = {
      comment: m(InputField, { fmt, title: fmt('{comment}') })
    }
    return m(Msgbox, {
        title: fmt('{Was the sample for lab taken?}'),
        fields,
        buttons: [
          m(StdButton, {
              text: fmt('{Yes}'),
              onclick: _e => {
                  m.request({ url: 'sample/taken/' + vnode.attrs.id, method: 'POST', body: DataFromFormFields(fields) }).then((data) => {
                    ServerMessages.set(data)
                    m.route.set("/")  // To expeditions
                  })
              },
          }),
          m(StdButton, { text: fmt('{No}'), onclick: _e => { m.route.set("/") } } )
        ]
    } )
  }
}

const StatConsumption = {
  oninit: vnode => {
    const actualDate = new Date()
    vnode.state.data = {}
    vnode.state.data.date_from = std_date_format(actualDate)
    vnode.state.data.time_from = "00:00:00"
    vnode.state.data.date_to = std_date_format(actualDate)
    vnode.state.data.time_to = "23:59:59"
  },
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = {
      lang: m(LanguageField, {lang: vnode.attrs.lang}),
      date_from: m(InputField, {
          value: vnode.state.data.date_from,
          name: 'date_from',
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date from}'),
          onchange_callback: x => { vnode.state.data.date_from = x },
      }),
      time_from: m(InputField, {
          value: vnode.state.data.time_from,
          name: 'time_from',
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time from}'),
          onchange_callback: x => { vnode.state.data.time_from = x },
      }),
      date_to: m(InputField, {
          value: vnode.state.data.date_to,
          name: 'date_to',
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date to}'),
          onchange_callback: x => { vnode.state.data.date_to = x },
      }),
      time_to: m(InputField, {
          value: vnode.state.data.time_to,
          name: 'time_to',
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time to}'),
          onchange_callback: x => { vnode.state.data.time_to = x },
      }),
    }

    return m(FormPage, { fmt, title: fmt("{Material consumption}") },
      m('form', { action: 'print/consumption', method: 'GET', target: '_blank' },
        formFieldsToLayout(fields),
        m(PrintoutSubmitButtons, {fmt})
      )
    )
  }
}

const StatProduction = {
  oninit: vnode => {
    vnode.state.customers = {}
    m.request({ url: 'select/Customer' }).then(data => {
        vnode.state.customers = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    })
    vnode.state.construction_sites = {}
    m.request({ url: 'select/ConstructionSite' }).then(data => {
        vnode.state.construction_sites = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    })
    /* Opposite to Expeditions, here can be only 'name', not a composite of x.number, x.name etc...
       Filtering is based of exact value of that field, sent via GET request, and in DB we have just "plain" recipe names.
       Not-so-great-solution, but solving this means refactoring of SmartSelectBox component (to support "name"-> "value" pairs or so).
    */
    vnode.state.recipes = {}
    m.request({ url: 'nonempty_recipes' }).then(data => {
        vnode.state.recipes = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    })

    const actualDate = new Date()
    vnode.state.data = {}
    vnode.state.data.date_from = std_date_format(actualDate)
    vnode.state.data.time_from = "00:00:00"
    vnode.state.data.date_to = std_date_format(actualDate)
    vnode.state.data.time_to = "23:59:59"
    vnode.state.data.customer = null
    vnode.state.data.site = null
    vnode.state.data.recipe = null
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = {
      lang: m(LanguageField, {lang: vnode.attrs.lang}),
      customer: m(SmartSelectBox, {
          value: vnode.state.data.customer,
          fmt,
          field_name: 'customer',
          options: vnode.state.customers,
          title: fmt('{customer}'),
          onchange_callback: id => { vnode.state.data.customer = id },
      }),
      site: m(SmartSelectBox, {
          value: vnode.state.data.site,
          fmt,
          field_name: 'site',
          options: vnode.state.construction_sites,
          title: fmt('{construction_site}'),
          onchange_callback: id => { vnode.state.data.site = id },
      }),
      recipe: m(SmartSelectBox, {
          value: vnode.state.data.recipe,
          fmt,
          field_name: 'recipe',
          options: vnode.state.recipes,
          title: fmt('{recipe}'),
          onchange_callback: id => { vnode.state.data.recipe = id },
      }),
      date_from: m(InputField, {
          value: vnode.state.data.date_from,
          name: 'date_from',
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date from}'),
          onchange_callback: x => { vnode.state.data.date_from = x },
      }),
      time_from: m(InputField, {
          value: vnode.state.data.time_from,
          name: 'time_from',
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time from}'),
          onchange_callback: x => { vnode.state.data.time_from = x },
      }),
      date_to: m(InputField, {
          value: vnode.state.data.date_to,
          name: 'date_to',
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date to}'),
          onchange_callback: x => { vnode.state.data.date_to = x },
      }),
      time_to: m(InputField, {
          value: vnode.state.data.time_to,
          name: 'time_to',
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time to}'),
          onchange_callback: x => { vnode.state.data.time_to = x },
      }),
    }
    return m(FormPage, { fmt , title: fmt('{Production by orders}') },
      m('form', { action: 'print/production', method: 'GET', target: '_blank' },
        formFieldsToLayout(fields),
        m(PrintoutSubmitButtons, {fmt})
      )
    )
  }
}

/* Common form for both "production" and "invocices" overview printout.
   Those two printouts are almost the same, the type of printout is selected in "type" form field, see below
*/
const StatProductionOverview = {
  oninit: vnode => {
    m.request({ url: 'select/Customer' }).then(data => {
        vnode.state.customers = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    })
    m.request({ url: 'select/ConstructionSite' }).then(data => {
        vnode.state.construction_sites = nonHiddenRecordsToNamesObject(data.data, x => x.name)
    })

    const actualDate = new Date()
    vnode.state.data = {}
    vnode.state.data.date_from = std_date_format(actualDate)
    vnode.state.data.time_from = "00:00:00"
    vnode.state.data.date_to = std_date_format(actualDate)
    vnode.state.data.time_to = "23:59:59"
    vnode.state.data.customer = null
    vnode.state.data.site = null
  },

  view: vnode => {
    const fmt = vnode.attrs.fmt
    const loaded = vnode.state.customers && vnode.state.construction_sites
    const fields = loaded ? {
      lang: m(LanguageField, {lang: vnode.attrs.lang}),
      customer: m(SmartSelectBox, {
          value: vnode.state.data.customer,
          fmt,
          field_name: 'customer',
          options: vnode.state.customers,
          title: fmt('{customer}'),
          onchange_callback: id => { vnode.state.data.customer = id },
      }),
      site: m(SmartSelectBox, {
          value: vnode.state.data.site,
          fmt,
          field_name: 'site',
          options: vnode.state.construction_sites,
          title: fmt('{construction_site}'),
          onchange_callback: id => { vnode.state.data.site = id },
      }),
      date_from: m(InputField, {
          value: vnode.state.data.date_from,
          name: 'date_from',
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date from}'),
          onchange_callback: x => { vnode.state.data.date_from = x },
      }),
      time_from: m(InputField, {
          value: vnode.state.data.time_from,
          name: 'time_from',
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time from}'),
          onchange_callback: x => { vnode.state.data.time_from = x },
      }),
      date_to: m(InputField, {
          value: vnode.state.data.date_to,
          name: 'date_to',
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date to}'),
          onchange_callback: x => { vnode.state.data.date_to = x },
      }),
      time_to: m(InputField, {
          value: vnode.state.data.time_to,
          name: 'time_to',
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time to}'),
          onchange_callback: x => { vnode.state.data.time_to = x },
      }),
      type: m(SimpleSelectBox, {
          fmt,
          field_name: 'type',
          options: {
              1: fmt("{production_overview}"),
              2: fmt("{invoices_overview_card}"),
              3: fmt("{invoices_overview_cash}"),
          },
          title: fmt('{overview_type}'),
      }),
    } : {}
    return m(FormPage, { fmt , title: fmt('{production_invoices_overview}') },
      m('form', { action: 'print/production_overview', method: 'GET', target: '_blank' },
        formFieldsToLayout(fields),
        m(FormRow, m(''), m('', m(ButtonGenerate, {fmt}))),
      )
    )
  }
}

const StatStock = {
  oninit: vnode => {
    const actualDate = new Date()
    vnode.state.data = {}
    vnode.state.data.date_from = std_date_format(actualDate)
    vnode.state.data.time_from = "00:00:00"
    vnode.state.data.date_to = std_date_format(actualDate)
    vnode.state.data.time_to = "23:59:59"
  },
  view: vnode => {
    const fmt = vnode.attrs.fmt
    const fields = {
      lang: m(LanguageField, {lang: vnode.attrs.lang}),
      date_from: m(InputField, {
          value: vnode.state.data.date_from,
          name: 'date_from',
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date from}'),
          onchange_callback: x => { vnode.state.data.date_from = x},
      }),
      time_from: m(InputField, {
          value: vnode.state.data.time_from,
          name: 'time_from',
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time from}'),
          onchange_callback: x => { vnode.state.data.time_from = x },
      }),
      date_to: m(InputField, {
          value: vnode.state.data.date_to,
          name: 'date_to',
          placeholder: fmt("{date_placeholder}"),
          fmt,
          title: fmt('{Date to}'),
          onchange_callback: x => { vnode.state.data.date_to = x },
      }),
      time_to: m(InputField, {
          value: vnode.state.data.time_to,
          name: 'time_to',
          placeholder: fmt("{time_placeholder}"),
          fmt,
          title: fmt('{Time to}'),
          onchange_callback: x => { vnode.state.data.time_to = x },
      }),
    }
    return m(FormPage, { fmt, title: fmt('{Material stock}') },
      m('form', { action: 'print/stock', method: 'GET', target: '_blank' },
        formFieldsToLayout(fields),
        m(PrintoutSubmitButtons, {fmt})
      )
    )
  }
}

// TODO REF NTH cut-n-pasted from pyplace. WAIT RP - needs work in other projects
const by_key_to_by_lang = d => {
  let ret = {}
  for (const [k, v] of Object.entries(d)) {
    for (const [kk, vv] of Object.entries(v)) {
      if (!(kk in ret)) {
        ret[kk] = {}
      }
      ret[kk][k] = vv
    }
  }
  return ret
}

// TODO REF NTH cut-n-pasted from pyplace. WAIT RP - needs work in other projects
const _fmt = (s, vals) => {
  if (typeof s !== "string") {
      return s
  }
  return s.replace(/{(.*?)}/g, (_, k) => ((vals && vals[k] !== undefined && vals[k] !== null) ? _fmt(vals[k], vals) : '!' + k + '!'))
}

// FIXME separate to independent components: configuration, locks, ...maybe others
const GlobalWrapper = {
  oninit: vnode => {
    console.debug("GlobalWrapper.oninit", vnode)
    GlobalWrapper.reload_config()
  },

  reload_config: () => {
    console.debug("GlobalWrapper.reload_config")
    m.request({ url: 'config' }).then(data => {
        console.debug("got config", data)
        GlobalConfig = data
    })
    //userLocks.load()
  },

  view: vnode => {
    console.debug("GlobalWrapper.view", vnode)
    return vnode.children
  }
}

const Language = {
  oninit: vnode => {
    console.debug("Language.oninit", vnode)
    vnode.state.lang = vnode.attrs.lang || 'cs' // last language seen (should not be really needed)
    m.request('./captions').then(data => {
      console.debug("got captions")
      vnode.state.d_by_lang = by_key_to_by_lang(data)
    })
  },

  view: vnode => {
    console.debug("Language.view", vnode)
    const lang = vnode.attrs.lang || vnode.state.lang || 'cs'
    const lang_d = vnode.state.d_by_lang ? vnode.state.d_by_lang[lang] : {}
    // TODO REF NTH find a better way than "the_child"
    return m(vnode.attrs.the_child, {
      lang,
      fmt: (x) => _fmt(x, lang_d),
      ...m.route.param(),
    })
  }
}

const TranslatedScreen = (the_child) => {
  // please note this is not a mithril compoment but a routeResolver object (see mithril's documentation) -> therefore no "view" but "render". the purpose is to request caption data just once, not for each route change.
  return { render: () => m(GlobalWrapper, m(Language, { lang: urlParams.get('lang'), the_child })) }
}

m.route(document.body, '/', {
  '/': TranslatedScreen(Expeditions),
  '/login': TranslatedScreen(Login),

  '/orders': TranslatedScreen(Orders),
  '/order_edit/:id': TranslatedScreen(EditOrder),
  '/order_open/:id': TranslatedScreen(OpenOrder),

  '/replace_materials': TranslatedScreen(ReplaceMaterials),
  '/stockup_materials': TranslatedScreen(StockUpMaterials),

  '/recipes': TranslatedScreen(Recipes),
  '/recipe_open': TranslatedScreen(OpenRecipe),
  '/recipe_open/:id': TranslatedScreen(OpenRecipe),
  '/recipe_open/:id/:action': TranslatedScreen(OpenRecipe),

  '/materials': TranslatedScreen(Materials),
  '/material_open': TranslatedScreen(OpenMaterial),
  '/material_open/:id': TranslatedScreen(OpenMaterial),
  '/material/stock_movements/:id': TranslatedScreen(StockMovements),

  '/transport_types': TranslatedScreen(TransportTypes),
  '/transport_type_open': TranslatedScreen(OpenTransportType),
  '/transport_type_open/:id': TranslatedScreen(OpenTransportType),

  '/drivers': TranslatedScreen(Drivers),
  '/driver_open': TranslatedScreen(OpenDriver),
  '/driver_open/:id': TranslatedScreen(OpenDriver),

  '/vehicles': TranslatedScreen(Vehicles),
  '/vehicle_open': TranslatedScreen(OpenModel("Car")),
  '/vehicle_open/:id': TranslatedScreen(OpenModel("Car")),

  '/discount_open/:customer': TranslatedScreen(OpenDiscount),
  '/discount_open/:customer/:id': TranslatedScreen(OpenDiscount),

  '/company_surcharges': TranslatedScreen(CompanySurcharges),
  '/company_surcharge_open': TranslatedScreen(OpenCompanySurcharge),
  '/company_surcharge_open/:id': TranslatedScreen(OpenCompanySurcharge),

  '/pump_surcharges': TranslatedScreen(PumpSurcharges),
  '/pump_surcharge_open': TranslatedScreen(OpenModel("PumpSurcharge")),
  '/pump_surcharge_open/:id': TranslatedScreen(OpenModel("PumpSurcharge")),

  '/transport_zones': TranslatedScreen(TransportZones),
  '/transport_zone_open': TranslatedScreen(OpenModel("TransportZone")),
  '/transport_zone_open/:id': TranslatedScreen(OpenModel("TransportZone")),

  '/pumps': TranslatedScreen(Pumps),
  '/pump_open': TranslatedScreen(OpenPump),
  '/pump_open/:id': TranslatedScreen(OpenPump),

  '/pump_order': TranslatedScreen(PumpOrder),
  '/pump_order/:id': TranslatedScreen(PumpOrder),
  '/pump_orders': TranslatedScreen(PumpOrders),

  '/customers': TranslatedScreen(Customers),
  '/customer_open': TranslatedScreen(OpenCustomer),
  '/customer_open/:id': TranslatedScreen(OpenCustomer),

  '/sites': TranslatedScreen(Sites),
  '/site_open': TranslatedScreen(OpenSite),
  '/site_open/:id': TranslatedScreen(OpenSite),

  '/contracts': TranslatedScreen(Contracts),
  '/contract_open': TranslatedScreen(OpenContract),
  '/contract_open/:id': TranslatedScreen(OpenContract),

  '/defaults': TranslatedScreen(Defaults),
  '/defaults_open': TranslatedScreen(OpenDefaults),
  '/defaults_open/:id': TranslatedScreen(OpenDefaults),

  '/users': TranslatedScreen(Users),
  '/user_open': TranslatedScreen(OpenUser),
  '/user_open/:id': TranslatedScreen(OpenUser),

  '/locked_table_open/:user_id': TranslatedScreen(OpenLockedTable),

  '/setup': TranslatedScreen(Setup),

  '/samples': TranslatedScreen(Samples),
  '/sample_msgbox/:id': TranslatedScreen(SampleMsgbox),

  '/stat_consumption': TranslatedScreen(StatConsumption),
  '/stat_production': TranslatedScreen(StatProduction),
  '/stat_production_ov': TranslatedScreen(StatProductionOverview),
  '/stat_stock': TranslatedScreen(StatStock)
})

