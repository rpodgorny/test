""" imports data from legacy data formats
    Main routines are:
        import_minidisp_data
        import_atxd300_data
    (the rest of module are helpers)
"""
import os
import logging
from peewee import DoesNotExist
from atxpylib import configparser

from . import model
from . import func
from .func import DBFReader
import dbf


# TODO: are we sure the default encoding for minidisp is utf-8? QUE unspecified:
#   Default encoding was not found in communication files specification.
#   It can be (probably) found here (unacessible to me so I can't check the status):
#       https://wiki.asterix.cz/KomunikacniSoubory
#   Either define encoding or specify desired behaviour here. This function can, for example, try to detect "wrong"
#   encoding and fail, but such test will be most probably not 100%.
#   However, I would very recommend to make it clear in communication files specification
def cleaned_inifile(fn, encoding="utf-8"):
    """Reads inifile, strips out damaged lines, returns
    cleaned ini
    (original code can be found in baris_bridge, whatever it is)
    """
    with open(fn, "r", encoding=encoding) as f:
        lines = f.readlines()
    if lines and lines[0].startswith("="):
        logging.warning("found excess '=' in %s" % fn)
        lines.pop(0)
    ini = configparser.AtxConfigParser(encoding=encoding)
    ini.read_string("".join(lines))
    return ini


# TODO REF: copied from baris_bridge & modified - unite!
def ini_to_list(fn):
    ret = []
    ini = cleaned_inifile(fn)
    for sec in ini.sections():
        mr = dict(ini[sec])
        mr["_k_orig"] = sec
        ret.append(mr)
    return ret


def minidisp_defaults_import(fn):
    defaults = [x for x in ini_to_list(fn) if x["_k_orig"].lower() == "default"][0]

    model.Defaults.create(
        name="Imported",
        batch_volume_limit=defaults.get("MaxBatch"),
        lift_pour_duration=defaults.get("LiftPour"),
        lift_semi_pour_duration=defaults.get("AproxPour"),
        k_value=defaults.get("kvalue"),
        k_ratio=defaults.get("kratio"),
        mixing_duration=defaults.get("MixDuration"),
        mixer_semi_opening_duration=defaults.get("BaySemiOpen"),
        mixer_opening_duration=defaults.get("BayOpen"),
        consistency=defaults.get("Consistency"),
    )


def minidisp_recipes_import(fn):
    def material_by_name(material):
        try:
            return model.Material.get(name=material)
        except DoesNotExist:
            pass

    def is_material_legal(entry):
        for material_name in ["Cement", "CleanWater", "RecycledWater", "Admixture", "Aggregate", "Addition"]:
            if entry.startswith(material_name):
                return True

    recipes_data = ini_to_list(fn)
    for recipe in recipes_data:
        materials = []

        recipe_name = recipe.get("Recipe")
        material_entries = [x.split("_")[0] for x in recipe.keys() if "Name" in x]

        for entry in material_entries:
            if not is_material_legal(entry):
                logging.critical(f"FATAL: import can't recognize {entry} in recipe {recipe_name}")
                return 1

            material_name = recipe.get(f"{entry}_Name")
            if not material_name:
                logging.debug(f"Import skipped {entry} for recipe {recipe_name}. Reason: empty name")
                continue

            material = material_by_name(material_name)
            if not material:
                logging.critical(f"FATAL: Import can't find material {material_name} in entry {entry} for recipe {recipe_name}.")
                return 1

            materials.append(model.RecipeMaterial(material=material, amount=recipe.get(f"{entry}_Weight"), delay=recipe.get(f"{entry}_Delay")))

        recipe = model.Recipe.create(
            name=recipe_name,
            recipe_class=recipe.get("Class"),
            description=recipe.get("Description"),
            comment=recipe.get("Note"),
            consistency_class=recipe.get("Consistency"),
            batch_volume_limit=recipe.get("MaxBatch"),
            lift_pour_duration=recipe.get("LiftPour"),
            lift_semi_pour_duration=recipe.get("AproxPour"),
            mixer_semi_opening_duration=recipe.get("BaySemiOpen"),
            mixer_opening_duration=recipe.get("BayOpen"),
            mixing_duration=recipe.get("MixDuration"),
            k_value=recipe.get("kvalue"),
            k_ratio=recipe.get("kratio"),
        )

        for material in materials:
            material.recipe = recipe
            material.save()

        logging.info(f"Imported recipe {recipe_name}, {len(materials)} materials")


def minidisp_materials_import(fn):
    for material in ini_to_list(fn):
        material_type = material.get("Type")
        if material_type.lower() in ["cleanwater", "recycledwater"]:
            material_type = "Water"
        try:
            model.Material.create(
                type=material_type,
                name=material.get("Indication"),
                long_name=material.get("Description"),
                unit=material.get("Unit"),
                comment=material.get("Note"),
            )
        except ValueError:
            logging.warning(f"Material import skipped due to unsupported type {material_type}")


@model.db.atomic()
def import_minidisp_data(path):
    """Imports all data from legacy (*.INI) format
    import is (has to be) in this order: materials -> recipes -> archive

    Return value: 0 if success, 1 otherwise
    """
    logging.info(f"will try to import minidisp data from {path}")

    defaults_fn = func.asterixed_path(path, "default.ini")
    materials_fn = func.asterixed_path(path, "material_list.ini")
    recipes_fn = func.asterixed_path(path, "recipe_list.ini")

    if os.path.exists(defaults_fn):
        minidisp_defaults_import(defaults_fn)
    else:
        logging.warning(f"{defaults_fn} does not exists. Defaults not imported, but I continue.")

    if os.path.exists(materials_fn):
        minidisp_materials_import(materials_fn)
    else:
        logging.critical(f"{materials_fn} does not exists. Import aborted.")
        return 1  # materials are necessary for import

    if os.path.exists(recipes_fn):
        ret = minidisp_recipes_import(recipes_fn)
        if ret:
            return ret

    logging.info("minidisp import complete")

    return 0


def _import_materials_from_dbf(fn):
    dbf_id_to_new_id_map = {}
    with DBFReader(fn) as reader:
        for record in reader:
            id_mat = record["ID_MAT"]
            logging.info(f"Importing material {id_mat} from DBF file {fn}")
            type_ = {
                1: "Aggregate",
                2: "Cement",
                3: "Admixture",
                4: "Addition",
                5: "Water",  # CleanWater
                6: "Water",  # RecycledWater
            }.get(record["TYP"])
            if type_ is None:
                logging.warning("unknown type")
                continue
            try:
                m = model.Material.create(
                    id=id_mat,
                    long_name=record["NAZEV"].strip(),
                    name=record["NAZEV_RIZE"].strip(),
                    type=type_,
                    unit=record["MNOZ_JEDNO"].strip(),
                )
                dbf_id_to_new_id_map[id_mat] = m.id
            except Exception as e:
                logging.exception(f"Error importing material from DBF: {e}")
    return dbf_id_to_new_id_map


def _import_recipes_from_dbf(fn):
    with DBFReader(fn) as reader:
        for record in reader:
            id_rec = record["ID_REC"]
            logging.info(f"Importing recipe {id_rec} from DBF file {fn}")
            try:
                # TODO - finish all fields
                number = record["CISLO"]
                number = None if number == 0 else str(number)
                recipe = model.Recipe.create(
                    name=record["NAZEV"].strip(),
                    recipe_class=record["TRIDA"].strip(),
                    #exposure_classes=
                    #description= - VARIANTA?
                    comment=record["POZNAMKA"].strip(),
                    consistency_class=record["KONZISTENC"].strip(),
                    batch_volume_limit=record["MAX_MNOZST"],
                    lift_pour_duration=record["DOBA_VYSYP"],  # ???
                    lift_semi_pour_duration=record["DOBA_SKORO"],  # ???
                    mixer_semi_opening_duration=record["DOBA_POOTE"],
                    mixer_semi_opening2_duration=record["DOBA_POOT2"],  # ???
                    mixer_opening_duration=record["DOBA_OTEVR"],
                    mixing_duration=record["DOBA_MICHA"],
                    workability_time=record["ZPRACOVAT"],  # ???
                    price=record["CENA"],
                    k_value=record["ACCAWR_1"],  # ???
                    k_ratio=record["POMER_1"],  # ???
                    number=number,
                    #d_max=record["ZRNITOST"].strip(),
                    cl_content=record["OBSAH_CL"],
                )

                #mats = []
                for (mat_type, mat_abbrev, cnt) in [
                    ("Aggregate", "KAM", 9),
                    ("Cement", "CEM", 1),
                    ("Addition", "POJ", 2),
                    ("Admixture", "PRI", 8),
                    ("Water", "VOD", 4),
                ]:
                    for i in range(1, cnt + 1):
                        k_id = f"ID_{mat_abbrev}_{i}"
                        try:
                            id_ = record[k_id]
                        except dbf.FieldMissingError:  # TODO REF: leaky abstraction
                            continue
                        if id_ == 0:
                            continue
                        try:
                            material = model.Material.get_by_id(id_)
                        except:
                            continue
                        try:
                            delay = record[f"ZPOZ_{mat_abbrev}_{i}"]
                        except dbf.FieldMissingError:
                            delay = None
                        try:
                            k_value = record[f"ACCAWR_{mat_abbrev}_{i}"]
                        except dbf.FieldMissingError:
                            k_value = None
                        try:
                            k_ratio = record[f"POMER_{mat_abbrev}_{i}"]
                        except dbf.FieldMissingError:
                            k_ratio = None
                        rec_mat = model.RecipeMaterial.create(
                            recipe=recipe,
                            material=material,
                            amount=record[f"MNOZ_{mat_abbrev}_{i}"],
                            delay=delay,
                            k_value=k_value,
                            k_ratio=k_ratio,
                            #k_value=record.get(f"ACCAWR_{i}"),
                            #k_ratio=record.get(f"POMER_{i}"),
                        )
                        print("IMPORTED MATERIAL DUMP:", rec_mat.as_json())
            except Exception as e:
                logging.exception(f"Error importing recipe from DBF: {e}")


def _import_cars_from_dbf(fn):
    with DBFReader(fn) as reader:
        for record in reader:
            spz = record["SPZ"].strip()
            logging.info(f"Importing Car {spz} from DBF file {fn}")
            driver_name = record["JMENO"].strip()
            if not driver_name:
                driver = None
            else:
                driver = model.Driver.create(
                    name=driver_name,
                    contact=record["TELEFON"].strip(),
                )
            model.Car.create(
                registration_number=spz,
                driver=driver,
                operator=record["PROVOZOVAT"].strip() or None,
                car_type=record["VOZIDLO_TY"].strip() or None,
            )


def _import_customers_from_dbf(fn):
    with DBFReader(fn) as reader:
        for record in reader:
            name = record["NAZEV"].strip()
            if not name:
                continue
            logging.info(f"Importing Customer {name} from DBF file {fn}")
            model.Customer.create(
                name=name,
                address=record["ULICE"].strip(),
                city=record["MESTO"].strip(),
                zip=record["PSC"].strip(),
                phone=record["TEL"].strip(),
                fax=record["FAX"].strip(),
                company_idnum=record["ICO"].strip(),
                vat_idnum=record["DIC"].strip(),
                payment_type=model.PAYMENT_INVOICE if record["UHRADA"].strip() == "fakturou" else model.PAYMENT_CASH,
                comment=record["NAZEV2"].strip(),
            )


def _import_sites_from_dbf(fn):
    with DBFReader(fn) as reader:
        for record in reader:
            name = record["NAZEV"].strip()
            if not name:
                continue
            logging.info(f"Importing ConstructionSite {name} from DBF file {fn}")
            phone = record["TEL"].strip()
            try:
                model.ConstructionSite.create(
                    name=name,
                    address=record["ULICE"].strip(),
                    city=record["MESTO"].strip(),
                    zip=record["PSC"].strip(),
                    comment=f"Tel.: {phone}" if phone else None,
                    distance=int(record["VZDALENOST"]),
                )
            except Exception as e:
                logging.exception(f"Error importing site from DBF: {e}")


#@model.db.atomic()
def import_atxd300_data(path):
    """ Imports data from legacy DBF format used in atxd300
        Imported directory is afterwards renamed to <original>_imported, in order to
            1) prevent importing the file again
            2) prevent atxd300 to run, applying naked IT brutality
    """
    logging.info(f"will try to import atxd300 data from {path}")

    # TODO: also import the "hidden" attribute for all entities
    with model.db.atomic():
        mat_id_map = _import_materials_from_dbf(f"{path}/MATERIAL.DBF")
        print("ID_MAP", mat_id_map)
        _import_recipes_from_dbf(f"{path}/RECEPTURA.DBF")
        _import_cars_from_dbf(f"{path}/DOPRAVA.DBF")
        _import_customers_from_dbf(f"{path}/ODBERATEL.DBF")
        _import_sites_from_dbf(f"{path}/STAVBA.DBF")

    logging.info("atxd300 import complete")

    return 0
