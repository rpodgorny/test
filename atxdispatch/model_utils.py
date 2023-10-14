import random
import logging
import time

import peewee

import atxdispatch.model as model
import atxdispatch.func as func


@model.db.atomic()
def create_tables():
    model.db.drop_tables(model.TABLES)
    model.db.create_tables(model.TABLES)


@model.db.atomic()
def clear_db():
    """Clears all tables in DB"""
    for table in model.TABLES:
        logging.debug("will delete data from %s" % table)
        table.delete().execute()


@model.db.atomic()
def populate_db():
    """Populates DB with test data"""

    materials = [
        model.Material.create(type="Aggregate", name="Sand", unit="kg"),
        model.Material.create(type="Cement", name="Cement1", unit="kg"),
        model.Material.create(type="Cement", name="Cement2", unit="kg"),
        model.Material.create(type="Water", name="Water1", unit="l"),
        model.Material.create(type="Admixture", name="Mixture 1", unit="kg"),
        model.Material.create(type="Admixture", name="Mixture 2", unit="kg"),
        model.Material.create(type="Admixture", name="NeverUsedMaterial", unit="kg"),  # this material should never be used
        model.Material.create(type="Addition", name="Addition1", unit="kg"),
    ]

    model.StockMovement.create(material=materials[0], amount=3)
    model.StockMovement.create(material=materials[0], amount=5, comment="Big car with sand arrived")

    recipes = [
        model.Recipe.create(
            name="myrecipe",
            recipe_class="c1",
            consistency_class="S4",
            k_ratio=1.2,
            k_value=2.3,
            batch_volume_limit=40,
            mixing_duration=20.0,
            lift_pour_duration=8.1,
            lift_semi_pour_duration=8.2,
            mixer_semi_opening_duration=6.1,
            mixer_opening_duration=6.2,
            price=2000
        ),
    ]
    model.RecipeMaterial.create(material=materials[0], recipe=recipes[0], amount=1, delay=None)  # aggregate
    model.RecipeMaterial.create(material=materials[1], recipe=recipes[0], amount=3, delay=4)  # cement
    model.RecipeMaterial.create(material=materials[3], recipe=recipes[0], amount=5, delay=6)  # water
    model.RecipeMaterial.create(material=materials[4], recipe=recipes[0], amount=7, delay=8)  # ad mixture

    model.RecipeProduction.create(
        recipe=recipes[0],
        sample_period_days=2,
        sample_period_volume=3,
    )

    order = model.Order.create(
        user="John",
        r_recipe_class="X",
        r_name="X",
        r_batch_volume_limit=1,
        volume=1,
        r_lift_pour_duration=0,
        r_lift_semi_pour_duration=0,
        r_mixer_semi_opening_duration=0,
        r_mixer_opening_duration=0,
        r_mixing_duration=0,
        r_k_value=0,
        r_k_ratio=0,
        auto_number=1,
    )
    seq = 0
    for mat in materials:
        seq += 1
        model.OrderMaterial.create(type=mat.type, name=mat.name, material=mat, order=order, sequence_number=seq, amount=1)

    model.Setup.create(company_name="SuperConcreteMaker")

    transport_types = [
        model.TransportType.create(name="mix"),
        model.TransportType.create(name="sklopka"),
    ]

    drivers = [
        model.Driver.create(name="Pepa Novak", contact="603 22 33 11", comment="Jezdi vzdycky pozde"),
        model.Driver.create(name="Jan Horak"),
    ]

    vehicles = [
        model.Car.create(registration_number="2aa 5645", driver=drivers[0], comment="Blue car", transport_type=transport_types[0]),
        model.Car.create(registration_number="2S4 4856", comment="Yellow car"),
        model.Car.create(registration_number="LIMITED"),  # Record holding no additional data
    ]

    sites = [
        model.ConstructionSite.create(name="Most u Branika", city="Praha", distance=50),
        model.ConstructionSite.create(name="Zastavka Horni Dolni"),
    ]

    customers = [
        model.Customer.create(name="RSD a.s.", comment="Neplati. Pouze na fakturu"),
        model.Customer.create(name="Ceské dráhy a.s."),
    ]

    customer_prices = [
        model.Price.create(customer=customers[0], amount=1000, type=model.Price.PRICE_TYPE_ABSOLUTE),
        model.Price.create(customer=customers[0], recipe=recipes[0], amount=500, type=model.Price.PRICE_TYPE_RELATIVE),
    ]

    model.Contract.create(name="Rekonstrukce dalnice D1", construction_site=sites[0], customer=customers[0])
    model.Contract.create(name="Rekonstrukce zastavek koridor", construction_site=sites[1], customer=customers[1], default_volume=4.2)
    model.Contract.create(
        name="Zabetonovani konzole na policku",
        construction_site=sites[1],
        customer=customers[1],
        recipe=recipes[0],
        vehicle=vehicles[0],
    )

    # Those are intentionally not sorted by distance, in order to make
    # test_transport_zone_calculation work in more real-data-like environment
    transport_zones = [
        model.TransportZone.create(distance_km_max=10, price_per_m3=100),
        model.TransportZone.create(distance_km_max=30, price_per_m3=200),
        model.TransportZone.create(distance_km_max=20, price_per_m3=150),
        model.TransportZone.create(distance_km_min=1, distance_km_max=100, price_per_m3=250),
        model.TransportZone.create(distance_km_min=1, distance_km_max=100, distance_max_inclusive=True, price_per_m3=260, transport_type=transport_types[0]),
    ]

    pumps = [
        model.Pump.create(registration_number="111 PUMP"),
    ]

    pump_orders = [
        model.PumpOrder.create(pump_record=pumps[0])
    ]

    defaults = [
        model.Defaults.create(name="foo")
    ]

    model.User.create(username="john", password_hash_sha256=model.User.hash("1234"), can_edit_users=True)
    model.User.create(username="frank", password_hash_sha256=model.User.hash("1111"))


def clear_and_populate_db():
    """ Creates standard db for tests with a test data """
    clear_db()
    populate_db()



@model.db.atomic()
def bigdata(amount):
    """Populates DB with <amount> of test data in most tables"""

    old_journal_mode = model.db.journal_mode

    # Temporarily switch-off journal, otherwise write operations are VERY slow, writing alot of data to disk.
    # Note that setting journal_mode="off" disables atomic operation rollback - that means risk of corrupted DB.
    # !! so do not dare to use it as a performance issue quickfix, especially in production !!!
    model.db.journal_mode = "off"

    # It is very naive implementation just for DEV purposes:
    # slow and sometimes can fail on "non unique" constraint (because names are generated randomly)
    for i in range(amount):
        try:
            m = model.Material.create(type=random.choice(model.Material.ALLOWED_TYPES), name=f"Material {func.random_string()[:20]}", unit="kg")
            r = model.Recipe.create(name=f"Recipe {func.random_string()[:20]}", recipe_class="c1", consistency_class="S4")
            model.RecipeMaterial.create(material=m, recipe=r, amount=random.random() * 100, delay=random.choice([None, 0, 2, 3.3]))
            model.Order.create(customer=f"For customer {func.random_string()[:20]}", volume=random.random() * 100, recipe=r, auto_number=1000 + i, r_name=r.name, r_recipe_class=r.recipe_class)
            d = model.Driver.create(name=f"John Doe {func.random_string()[:20]}", contact="603 22 33 11", comment="Driver")
            model.Car.create(registration_number=f"2AA {func.random_string()[:20]}", driver=d, comment="Car")
            site = model.ConstructionSite.create(name=f"Stavba {func.random_string()[:30]}", city="Praha", distance=random.random() * 100)
            customer = model.Customer.create(name=f"Zakaznik {func.random_string()[:30]}", comment="Foo")
            model.Contract.create(name=f"Kontrakt {func.random_string()[:30]}", site=site, customer=customer)
            print(f"Generated {i} of {amount} dummy data")
        except peewee.IntegrityError:
            print("integrity error!")

    model.db.journal_mode = old_journal_mode


# TODO: why is this not included in populate?
def create_random_batches(order):
    for i in range(1, 4):
        record = model.Batch.create(
            order=order,
            volume=random.randint(10, 30) / 10,
            batch_number=i
        )
        for material in order.materials:
            model.BatchMaterial.create(
                batch=record,
                material=material,
                amount_recipe=material.amount,
                amount_rq=random.randint(10, 30) / 10,
                amount_e1=random.randint(10, 30) / 10,
                production_start_t=time.time()
            )

